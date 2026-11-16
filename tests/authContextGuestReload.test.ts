import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';

interface MockStorage extends Storage {
  dump(): Record<string, string>;
}

function createMemoryStorage(initial: Record<string, string> = {}): MockStorage {
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
      store.set(String(key), String(value));
    },
    dump() {
      return Object.fromEntries(store.entries());
    }
  };
}

function installTestDomEnvironment(options?: {
  sessionStorage?: MockStorage;
  localStorage?: MockStorage;
}) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevSessionStorage = (globalThis as any).sessionStorage;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

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
      c.parentNode = this;
      return c;
    },
    removeChild(c: any) {
      this.childNodes = this.childNodes.filter((x: any) => x !== c);
      return c;
    },
    insertBefore(c: any, _ref: any) {
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    },
    hasChildNodes() {
      return this.childNodes.length > 0;
    },
    setAttribute() {},
    removeAttribute() {}
  });

  const view: any = {
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {}
  };

  const doc: any = {
    nodeType: 9,
    documentElement: null as any,
    body: null as any,
    defaultView: view,
    activeElement: null,
    createElement(tag: string) {
      return makeEl(tag, doc);
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: text, ownerDocument: doc };
    },
    addEventListener() {},
    removeEventListener() {}
  };
  doc.documentElement = makeEl('html', doc);
  doc.body = makeEl('body', doc);

  const sStorage = options?.sessionStorage || createMemoryStorage();
  const lStorage = options?.localStorage || createMemoryStorage();

  view.sessionStorage = sStorage;
  view.localStorage = lStorage;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = view;
  (globalThis as any).document = doc;
  (globalThis as any).sessionStorage = sStorage;
  (globalThis as any).localStorage = lStorage;

  const container = makeEl('div', doc);

  const restore = () => {
    if (prevActEnv === undefined) delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;

    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;

    if (prevDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDocument;

    if (prevSessionStorage === undefined) delete (globalThis as any).sessionStorage;
    else (globalThis as any).sessionStorage = prevSessionStorage;

    if (prevLocalStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = prevLocalStorage;
  };

  return { container, sessionStorage: sStorage, localStorage: lStorage, restore };
}

interface FakeUser {
  uid: string;
  email: string;
  displayName?: string;
  isAnonymous?: boolean;
}

function createFakeFirebaseController(initialPersistedUser: FakeUser | null = null) {
  let persistedUser: FakeUser | null = initialPersistedUser;
  const profiles = new Map<string, { uid: string; username: string; email: string }>();
  const activeListeners = new Set<(user: FakeUser | null) => void>();
  let totalSubscriptions = 0;
  let totalUnsubscriptions = 0;
  let syncInitialEmission = false;
  let profileFetchDelayMs = 0;

  const notifyAll = (user: FakeUser | null) => {
    for (const listener of Array.from(activeListeners)) {
      listener(user);
    }
  };

  const authDeps = {
    isFirebaseConfigured: () => true,
    isBrowserOnline: () => true,
    onAuthChange: (cb: (user: FakeUser | null) => void) => {
      totalSubscriptions += 1;
      activeListeners.add(cb);
      if (syncInitialEmission) {
        cb(persistedUser);
      } else {
        queueMicrotask(() => {
          if (activeListeners.has(cb)) {
            cb(persistedUser);
          }
        });
      }
      return () => {
        if (activeListeners.delete(cb)) {
          totalUnsubscriptions += 1;
        }
      };
    },
    loginWithEmail: async (email: string, _password: string) => {
      const uid = `fb-${email.trim().toLowerCase()}`;
      const existingProfile = profiles.get(uid);
      const user: FakeUser = {
        uid,
        email: email.trim(),
        displayName: existingProfile?.username || 'Existing User'
      };
      persistedUser = user;
      notifyAll(user);
      return { user };
    },
    signupWithEmail: async (email: string, _password: string) => {
      const uid = `fb-new-${email.trim().toLowerCase()}`;
      const user: FakeUser = {
        uid,
        email: email.trim(),
        displayName: ''
      };
      persistedUser = user;
      notifyAll(user);
      return { user };
    },
    logout: async () => {
      persistedUser = null;
      notifyAll(null);
    },
    getUserProfile: async (uid: string) => {
      if (profileFetchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, profileFetchDelayMs));
      }
      return profiles.get(uid) || null;
    },
    saveUserProfile: async (uid: string, data: { username: string; email?: string }) => {
      profiles.set(uid, {
        uid,
        username: data.username,
        email: data.email || ''
      });
    }
  };

  return {
    authDeps,
    profiles,
    setSyncInitialEmission(sync: boolean) {
      syncInitialEmission = sync;
    },
    setProfileFetchDelayMs(ms: number) {
      profileFetchDelayMs = ms;
    },
    setPersistedUser(user: FakeUser | null) {
      persistedUser = user;
    },
    emitAuthChange(user: FakeUser | null) {
      persistedUser = user;
      notifyAll(user);
    },
    getStats() {
      return {
        activeListenerCount: activeListeners.size,
        totalSubscriptions,
        totalUnsubscriptions
      };
    }
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

interface AuthContextValue {
  currentUser: FakeUser | null;
  userProfile: { uid: string; username?: string; email?: string } | null;
  username: string;
  updateUsername: (newUsername: string) => Promise<void>;
  initialLoading: boolean;
  actionLoading: boolean;
  error: string | null;
  clearError: () => void;
  signup: (email: string, password: string, username: string) => Promise<FakeUser>;
  login: (email: string, password: string) => Promise<FakeUser>;
  logout: () => Promise<void>;
  continueAsGuest: (preferredName?: string | null) => void;
  isConfigured: boolean;
}

function mountAuthHarness(
  container: any,
  authDeps: any,
  options?: { strictMode?: boolean }
) {
  let latestAuth: AuthContextValue | null = null;
  let latestScreen: 'splash' | 'auth' | 'chat' = 'splash';

  function AuthGateHarness() {
    const authCtx = useAuth() as unknown as AuthContextValue;
    latestAuth = authCtx;
    latestScreen = authCtx.initialLoading
      ? 'splash'
      : authCtx.currentUser
      ? 'chat'
      : 'auth';
    return null;
  }

  const root: Root = createRoot(container);
  const providerEl = React.createElement(
    AuthProvider as any,
    { authDeps },
    React.createElement(AuthGateHarness)
  );
  const tree = options?.strictMode
    ? React.createElement(StrictMode, null, providerEl)
    : providerEl;

  return {
    async mount() {
      await act(async () => {
        root.render(tree);
      });
      await flushMicrotasks();
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
    getAuth(): AuthContextValue {
      assert.ok(latestAuth, 'Auth context should be available');
      return latestAuth;
    },
    getScreen() {
      return latestScreen;
    }
  };
}

test('HIGH-01: Fresh launch without session shows AuthScreen, supports Firebase signup and login, and unsubscribes cleanly on unmount', async () => {
  const dom = installTestDomEnvironment();
  const fb = createFakeFirebaseController(null);
  const harness = mountAuthHarness(dom.container, fb.authDeps);

  try {
    await harness.mount();
    assert.equal(harness.getAuth().initialLoading, false);
    assert.equal(harness.getAuth().currentUser, null);
    assert.equal(harness.getScreen(), 'auth');
    assert.equal(fb.getStats().activeListenerCount, 1);

    // Signup
    await act(async () => {
      await harness.getAuth().signup('alice@example.com', 'secret123', 'Alice');
    });
    assert.equal(harness.getAuth().currentUser?.email, 'alice@example.com');
    assert.equal(harness.getAuth().username, 'Alice');
    assert.equal(harness.getScreen(), 'chat');

    // Logout
    await act(async () => {
      await harness.getAuth().logout();
    });
    assert.equal(harness.getAuth().currentUser, null);
    assert.equal(harness.getScreen(), 'auth');

    // Login
    await act(async () => {
      await harness.getAuth().login('bob@example.com', 'secret123');
    });
    assert.equal(harness.getAuth().currentUser?.email, 'bob@example.com');
    assert.equal(harness.getScreen(), 'chat');

    // Unmount cleans up subscription
    await harness.unmount();
    assert.equal(fb.getStats().activeListenerCount, 0);
    assert.equal(fb.getStats().totalSubscriptions, 1);
    assert.equal(fb.getStats().totalUnsubscriptions, 1);
  } finally {
    dom.restore();
  }
});

test('HIGH-01: Reload in Guest Mode still registers onAuthChange, preserves guest session across null emissions, then allows logout -> immediate Firebase login & signup without refresh', async () => {
  const sessionStorage = createMemoryStorage();
  const localStorage = createMemoryStorage();
  const dom = installTestDomEnvironment({ sessionStorage, localStorage });
  const fb = createFakeFirebaseController(null);

  try {
    // Session 1: Launch fresh -> enter Guest Mode
    const session1 = mountAuthHarness(dom.container, fb.authDeps);
    await session1.mount();
    assert.equal(session1.getScreen(), 'auth');

    await act(async () => {
      session1.getAuth().continueAsGuest('Guest Tester');
    });
    assert.equal(session1.getScreen(), 'chat');
    assert.equal(session1.getAuth().currentUser?.isAnonymous, true);
    assert.ok(sessionStorage.getItem('orvix_guest_session'));
    assert.ok(localStorage.getItem('orvix_guest_session'));
    await session1.unmount();

    // Session 2 (Browser Reload while in Guest Mode, Firebase emits null async)
    const session2 = mountAuthHarness(dom.container, fb.authDeps);
    await session2.mount();
    assert.equal(session2.getAuth().initialLoading, false);
    assert.equal(session2.getAuth().currentUser?.isAnonymous, true);
    assert.equal(session2.getAuth().username, 'Guest Tester');
    assert.equal(session2.getScreen(), 'chat');
    // Crucial HIGH-01 invariant: listener MUST still be subscribed after guest reload!
    assert.equal(fb.getStats().activeListenerCount, 1);

    // Guest logs out after browser reload -> transitions cleanly to AuthScreen
    await act(async () => {
      await session2.getAuth().logout();
    });
    assert.equal(session2.getAuth().currentUser, null);
    assert.equal(session2.getScreen(), 'auth');
    assert.equal(sessionStorage.getItem('orvix_guest_session'), null);
    assert.equal(localStorage.getItem('orvix_guest_session'), null);

    // Immediately authenticate via Firebase login (listener-driven, no browser reload)
    // Simulate a listener-only Firebase auth update first AND full loginWithEmail flow
    await act(async () => {
      await session2.getAuth().login('recovered@example.com', 'password123');
    });
    assert.equal(session2.getAuth().currentUser?.email, 'recovered@example.com');
    assert.equal(session2.getAuth().currentUser?.isAnonymous, undefined);
    assert.equal(session2.getScreen(), 'chat');

    // Logout again and verify external onAuthChange(user) emission updates state directly
    await act(async () => {
      await session2.getAuth().logout();
    });
    assert.equal(session2.getScreen(), 'auth');
    await act(async () => {
      fb.emitAuthChange({
        uid: 'fb-direct-emit',
        email: 'direct@example.com',
        displayName: 'Direct User'
      });
    });
    await flushMicrotasks();
    assert.equal(session2.getAuth().currentUser?.uid, 'fb-direct-emit');
    assert.equal(session2.getScreen(), 'chat');
    await session2.unmount();

    // Session 3: Verify subsequent reload stays logged in as Firebase user (no unintended guest restoration)
    const session3 = mountAuthHarness(dom.container, fb.authDeps);
    await session3.mount();
    assert.equal(session3.getAuth().currentUser?.uid, 'fb-direct-emit');
    assert.equal(session3.getAuth().currentUser?.isAnonymous, undefined);
    assert.equal(session3.getScreen(), 'chat');
    await session3.unmount();
  } finally {
    dom.restore();
  }
});

test('HIGH-01: Guest reload with synchronous initial onAuthChange(null) preserves guest session, then logout -> signup preserves username without race overwrite', async () => {
  const existingGuest = {
    uid: 'guest-reload99',
    email: 'guest@orvix.ai',
    displayName: 'Guest Explorer',
    username: 'Guest Explorer',
    isAnonymous: true
  };
  const sessionStorage = createMemoryStorage({
    orvix_guest_session: JSON.stringify(existingGuest)
  });
  const localStorage = createMemoryStorage({
    orvix_guest_session: JSON.stringify(existingGuest)
  });

  const dom = installTestDomEnvironment({ sessionStorage, localStorage });
  const fb = createFakeFirebaseController(null);
  // Simulate synchronous null emission (as occurs when auth is unconfigured or instant offline check)
  fb.setSyncInitialEmission(true);
  // Simulate slow background getUserProfile() racing against signup's saveUserProfile()
  fb.setProfileFetchDelayMs(40);

  try {
    const app = mountAuthHarness(dom.container, fb.authDeps);
    await app.mount();

    // Even after synchronous onAuthChange(null), restored guest stays signed in
    assert.equal(app.getAuth().currentUser?.uid, 'guest-reload99');
    assert.equal(app.getScreen(), 'chat');
    assert.equal(fb.getStats().activeListenerCount, 1);

    // Guest signs out
    await act(async () => {
      await app.getAuth().logout();
    });
    assert.equal(app.getAuth().currentUser, null);
    assert.equal(app.getScreen(), 'auth');

    // Immediately registers a new Firebase account -> must update currentUser and retain chosen username
    await act(async () => {
      await app.getAuth().signup('newuser@example.com', 'password123', 'NewUser123');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    assert.equal(app.getAuth().currentUser?.email, 'newuser@example.com');
    assert.equal(app.getAuth().username, 'NewUser123');
    assert.equal(app.getScreen(), 'chat');
    assert.equal(sessionStorage.getItem('orvix_guest_session'), null);
    assert.equal(localStorage.getItem('orvix_guest_session'), null);

    await app.unmount();
    assert.equal(fb.getStats().activeListenerCount, 0);
  } finally {
    dom.restore();
  }
});

test('HIGH-01: React StrictMode mount/unmount/remount and repeated reloads/transitions avoid duplicate subscriptions and stale state', async () => {
  const sessionStorage = createMemoryStorage();
  const localStorage = createMemoryStorage();
  const dom = installTestDomEnvironment({ sessionStorage, localStorage });
  const fb = createFakeFirebaseController(null);

  try {
    // 1. Mount under React.StrictMode
    const strictHarness = mountAuthHarness(dom.container, fb.authDeps, { strictMode: true });
    await strictHarness.mount();
    // StrictMode mounts -> unmounts -> remounts, leaving exactly 1 active listener
    assert.equal(fb.getStats().activeListenerCount, 1);

    // 2. Repeated transition cycle: Guest -> Logout -> Login -> Logout -> Guest
    await act(async () => {
      strictHarness.getAuth().continueAsGuest('LoopGuest');
    });
    assert.equal(strictHarness.getScreen(), 'chat');
    assert.equal(strictHarness.getAuth().currentUser?.isAnonymous, true);

    await act(async () => {
      await strictHarness.getAuth().logout();
    });
    assert.equal(strictHarness.getScreen(), 'auth');

    await act(async () => {
      await strictHarness.getAuth().login('cycle@example.com', 'pass1234');
    });
    assert.equal(strictHarness.getScreen(), 'chat');
    assert.equal(strictHarness.getAuth().currentUser?.email, 'cycle@example.com');
    assert.equal(localStorage.getItem('orvix_guest_session'), null);

    await act(async () => {
      await strictHarness.getAuth().logout();
    });
    assert.equal(strictHarness.getScreen(), 'auth');

    await act(async () => {
      strictHarness.getAuth().continueAsGuest('SecondGuest');
    });
    await strictHarness.unmount();
    assert.equal(fb.getStats().activeListenerCount, 0);

    // 3. Reload into SecondGuest under StrictMode, logout, login again
    const reloadHarness = mountAuthHarness(dom.container, fb.authDeps, { strictMode: true });
    await reloadHarness.mount();
    assert.equal(fb.getStats().activeListenerCount, 1);
    assert.equal(reloadHarness.getAuth().username, 'SecondGuest');
    assert.equal(reloadHarness.getScreen(), 'chat');

    await act(async () => {
      await reloadHarness.getAuth().logout();
    });
    assert.equal(reloadHarness.getScreen(), 'auth');

    await act(async () => {
      await reloadHarness.getAuth().login('final@example.com', 'pass1234');
    });
    assert.equal(reloadHarness.getAuth().currentUser?.email, 'final@example.com');
    assert.equal(reloadHarness.getScreen(), 'chat');

    await reloadHarness.unmount();
    assert.equal(fb.getStats().activeListenerCount, 0);
  } finally {
    dom.restore();
  }
});
