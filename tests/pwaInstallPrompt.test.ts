import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { SettingsProvider } from '../src/context/SettingsContext.jsx';
import Header from '../src/components/layout/Header.jsx';
import Sidebar from '../src/components/layout/Sidebar.jsx';
import { usePWAInstall, PWAInstallProvider } from '../src/hooks/usePWAInstall.js';

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

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockDomEnvironment(options?: {
  standalone?: boolean;
  userAgent?: string;
}) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevSessionStorage = (globalThis as any).sessionStorage;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

  const listenerStore = new WeakMap<object, Map<string, Set<Function>>>();
  const addEv = (target: object, type: string, fn: Function) => {
    let map = listenerStore.get(target);
    if (!map) {
      map = new Map();
      listenerStore.set(target, map);
    }
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(fn);
  };
  const removeEv = (target: object, type: string, fn: Function) => {
    listenerStore.get(target)?.get(type)?.delete(fn);
  };

  class FakeElement {
    tagName: string;
    nodeType = 1;
    ownerDocument: any;
    parentNode: any = null;
    childNodes: any[] = [];
    attributes = new Map<string, string>();
    style: Record<string, any> = {};
    className = '';
    disabled = false;
    type = '';
    id = '';
    value = '';

    constructor(tag: string, doc: any) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
    }

    get nodeName() {
      return this.tagName;
    }

    get classList() {
      const self = this;
      const tokens = () => self.className.split(/\s+/).filter(Boolean);
      return {
        add(...names: string[]) {
          const s = new Set(tokens());
          names.forEach((n) => s.add(n));
          self.className = Array.from(s).join(' ');
        },
        remove(...names: string[]) {
          const rem = new Set(names);
          self.className = tokens().filter((t) => !rem.has(t)).join(' ');
        },
        contains(name: string) {
          return tokens().includes(name);
        }
      };
    }

    get textContent(): string {
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue || '' : c.textContent || '')).join('');
    }

    set textContent(v: string) {
      this.childNodes = v ? [this.ownerDocument.createTextNode(String(v))] : [];
    }

    appendChild(c: any) {
      if (c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
      if (!this.childNodes.includes(c)) this.childNodes.push(c);
      c.parentNode = this;
      return c;
    }

    removeChild(c: any) {
      this.childNodes = this.childNodes.filter((x) => x !== c);
      c.parentNode = null;
      return c;
    }

    insertBefore(c: any, ref: any) {
      if (c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
      const existing = this.childNodes.indexOf(c);
      if (existing !== -1) this.childNodes.splice(existing, 1);
      const idx = ref ? this.childNodes.indexOf(ref) : -1;
      if (idx === -1) this.childNodes.push(c);
      else this.childNodes.splice(idx, 0, c);
      c.parentNode = this;
      return c;
    }

    hasChildNodes() {
      return this.childNodes.length > 0;
    }

    setAttribute(k: string, v: string) {
      const sv = String(v);
      this.attributes.set(k, sv);
      if (k === 'class') this.className = sv;
      else if (k === 'id') this.id = sv;
      else if (k === 'type') this.type = sv;
      else if (k === 'disabled') this.disabled = true;
    }

    getAttribute(k: string) {
      if (k === 'class') return this.className || null;
      if (k === 'id') return this.id || null;
      if (k === 'disabled') return this.disabled ? '' : null;
      return this.attributes.has(k) ? this.attributes.get(k)! : null;
    }

    hasAttribute(k: string) {
      return this.getAttribute(k) !== null;
    }

    removeAttribute(k: string) {
      this.attributes.delete(k);
      if (k === 'class') this.className = '';
      else if (k === 'id') this.id = '';
      else if (k === 'disabled') this.disabled = false;
    }

    addEventListener(type: string, fn: Function) {
      addEv(this, type, fn);
    }

    removeEventListener(type: string, fn: Function) {
      removeEv(this, type, fn);
    }

    dispatchEvent(ev: any) {
      if (!ev.target) ev.target = this;
      let cur: any = this;
      while (cur) {
        ev.currentTarget = cur;
        const set = listenerStore.get(cur)?.get(ev.type);
        if (set) {
          for (const fn of Array.from(set)) fn.call(cur, ev);
        }
        if (ev.bubbles === false) break;
        cur = cur.parentNode || (cur === doc ? view : cur === doc.documentElement ? doc : null);
      }
      return true;
    }

    click() {
      this.dispatchEvent({
        type: 'click',
        bubbles: true,
        cancelable: true,
        preventDefault() {},
        stopPropagation() {}
      });
    }

    focus() {
      doc.activeElement = this;
    }

    contains(node: any): boolean {
      if (node === this) return true;
      return this.childNodes.some((c) => (typeof c.contains === 'function' ? c.contains(node) : c === node));
    }
  }

  let standaloneMatches = Boolean(options?.standalone);
  const mediaListeners = new Set<(e: { matches: boolean }) => void>();

  const view: any = {
    innerWidth: 1280,
    innerHeight: 800,
    HTMLIFrameElement: class {},
    navigator: {
      userAgent: options?.userAgent || 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
      standalone: Boolean(options?.standalone)
    },
    matchMedia(query: string) {
      const isStandaloneQuery = query.includes('display-mode: standalone');
      return {
        matches: isStandaloneQuery ? standaloneMatches : true,
        addEventListener(_t: string, cb: (e: { matches: boolean }) => void) {
          if (isStandaloneQuery) mediaListeners.add(cb);
        },
        removeEventListener(_t: string, cb: (e: { matches: boolean }) => void) {
          if (isStandaloneQuery) mediaListeners.delete(cb);
        }
      };
    },
    addEventListener(type: string, fn: Function) {
      addEv(this, type, fn);
    },
    removeEventListener(type: string, fn: Function) {
      removeEv(this, type, fn);
    },
    dispatchEvent(ev: any) {
      const set = listenerStore.get(this)?.get(ev.type);
      if (set) {
        for (const fn of Array.from(set)) fn.call(this, ev);
      }
      return true;
    }
  };

  const doc: any = {
    nodeType: 9,
    documentElement: null as any,
    body: null as any,
    defaultView: view,
    activeElement: null,
    createElement(tag: string) {
      return new FakeElement(tag, doc);
    },
    createElementNS(_ns: string, tag: string) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: text, textContent: text, ownerDocument: doc, parentNode: null };
    },
    addEventListener(type: string, fn: Function) {
      addEv(this, type, fn);
    },
    removeEventListener(type: string, fn: Function) {
      removeEv(this, type, fn);
    },
    querySelectorAll() {
      return [];
    }
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);

  const sStorage = createMemoryStorage();
  const lStorage = createMemoryStorage();
  view.sessionStorage = sStorage;
  view.localStorage = lStorage;
  view.document = doc;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = view;
  (globalThis as any).document = doc;
  (globalThis as any).sessionStorage = sStorage;
  (globalThis as any).localStorage = lStorage;

  const container = new FakeElement('div', doc);
  doc.body.appendChild(container);

  const findAll = (predicate: (el: any) => boolean) => {
    const out: any[] = [];
    const visit = (n: any) => {
      for (const c of n.childNodes || []) {
        if (c.nodeType === 1) {
          if (predicate(c)) out.push(c);
          visit(c);
        }
      }
    };
    visit(container);
    return out;
  };

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

  return {
    window: view,
    container,
    findAll,
    emitStandaloneMatch(matches: boolean) {
      standaloneMatches = matches;
      mediaListeners.forEach((cb) => cb({ matches }));
    },
    restore
  };
}

function createFakeAuthDeps() {
  const user = { uid: 'guest-pwa', email: 'guest@orvix.ai', displayName: 'Guest', isAnonymous: true };
  return {
    isFirebaseConfigured: () => false,
    isBrowserOnline: () => true,
    onAuthChange: (cb: (u: any) => void) => {
      cb(user);
      return () => {};
    },
    loginWithEmail: async () => ({ user }),
    signupWithEmail: async () => ({ user }),
    logout: async () => {},
    getUserProfile: async () => null,
    saveUserProfile: async () => {}
  };
}

function mountHeaderAndSidebar(dom: ReturnType<typeof createMockDomEnvironment>, options?: { useProvider?: boolean }) {
  let latestHook: any = null;
  function HookReader() {
    latestHook = usePWAInstall();
    return null;
  }

  const root: Root = createRoot(dom.container as any);
  const content = [
    React.createElement(HookReader, { key: 'reader' }),
    React.createElement(Sidebar as any, {
      key: 'sidebar',
      isOpen: true,
      onClose: () => {},
      onNewChat: () => {}
    }),
    React.createElement(Header as any, {
      key: 'header',
      sidebarOpen: true,
      onToggleSidebar: () => {},
      onNewChat: () => {}
    })
  ];

  const appTree = React.createElement(
    AuthProvider as any,
    { authDeps: createFakeAuthDeps() },
    React.createElement(
      SettingsProvider as any,
      { settingsDeps: { loadSettings: async () => ({}), saveSettings: async () => ({}) } },
      options?.useProvider
        ? React.createElement(PWAInstallProvider as any, null, ...content)
        : React.createElement(React.Fragment, null, ...content)
    )
  );

  return {
    async mount() {
      await act(async () => {
        root.render(appTree);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
    getHook: () => latestHook,
    getHeaderInstallBtn: () =>
      dom.findAll((el) => el.tagName === 'BUTTON' && el.classList?.contains('header-pwa-install-btn'))[0] || null,
    getSidebarInstallBtn: () =>
      dom.findAll((el) => el.tagName === 'BUTTON' && el.classList?.contains('sidebar-pwa-install-btn'))[0] || null
  };
}

test('ORVIX-LOW-02: Header and Sidebar synchronize installability and clear consumed beforeinstallprompt after dismissal, blocking duplicate calls', async () => {
  const dom = createMockDomEnvironment();
  const harness = mountHeaderAndSidebar(dom);

  try {
    await harness.mount();

    assert.equal(harness.getHook().isInstallable, false);
    assert.equal(harness.getHeaderInstallBtn(), null);
    assert.equal(harness.getSidebarInstallBtn(), null);

    const deferredChoice = createDeferred<{ outcome: 'accepted' | 'dismissed'; platform: string }>();
    let prevented = false;
    let promptCalls = 0;

    const promptEvent = {
      type: 'beforeinstallprompt',
      preventDefault() {
        prevented = true;
      },
      prompt() {
        promptCalls += 1;
        return Promise.resolve();
      },
      userChoice: deferredChoice.promise
    };

    await act(async () => {
      dom.window.dispatchEvent(promptEvent);
    });

    assert.equal(prevented, true);
    assert.equal(harness.getHook().isInstallable, true);
    assert.ok(harness.getHeaderInstallBtn(), 'Header Install button should appear');
    assert.ok(harness.getSidebarInstallBtn(), 'Sidebar Install button should appear');

    // Trigger install via Sidebar button
    await act(async () => {
      harness.getSidebarInstallBtn()!.click();
    });

    assert.equal(promptCalls, 1);
    assert.equal(harness.getHook().isInstalling, true);
    // Both Header and Sidebar buttons reflect installing/disabled state immediately
    assert.equal(harness.getHeaderInstallBtn()!.disabled, true);
    assert.equal(harness.getSidebarInstallBtn()!.disabled, true);

    // Repeated attempt (via Header button or hook) while prompt is active/consumed must NOT call .prompt() again
    let secondAttemptResult: boolean | undefined;
    await act(async () => {
      harness.getHeaderInstallBtn()!.click();
      secondAttemptResult = await harness.getHook().install();
    });
    assert.equal(secondAttemptResult, false);
    assert.equal(promptCalls, 1);

    // User dismisses browser install prompt
    await act(async () => {
      deferredChoice.resolve({ outcome: 'dismissed', platform: 'web' });
      await Promise.resolve();
    });

    assert.equal(harness.getHook().isInstalling, false);
    assert.equal(harness.getHook().isInstalled, false);
    assert.equal(harness.getHook().isInstallable, false);
    assert.equal(harness.getHeaderInstallBtn(), null, 'Header Install button should disappear after dismissal');
    assert.equal(harness.getSidebarInstallBtn(), null, 'Sidebar Install button should disappear after dismissal');

    // Subsequent call or re-dispatching the SAME consumed event does NOT re-enable prompt
    await act(async () => {
      dom.window.dispatchEvent(promptEvent);
      const afterDismissResult = await harness.getHook().install();
      assert.equal(afterDismissResult, false);
    });
    assert.equal(promptCalls, 1);
    assert.equal(harness.getHeaderInstallBtn(), null);
    assert.equal(harness.getSidebarInstallBtn(), null);
  } finally {
    await harness.unmount();
    dom.restore();
  }
});

test('ORVIX-LOW-02: Acceptance and appinstalled synchronize across Header, Account Popover, and Sidebar (and handle rejected prompts safely)', async () => {
  const dom = createMockDomEnvironment();
  const harness = mountHeaderAndSidebar(dom, { useProvider: true });

  try {
    await harness.mount();

    // 1. Rejected prompt() clears consumed event and never causes unhandled rejection
    let failPromptCalls = 0;
    const rejectingPromptEvent = {
      type: 'beforeinstallprompt',
      preventDefault() {},
      prompt() {
        failPromptCalls += 1;
        return Promise.reject(new DOMException('Prompt already used', 'InvalidStateError'));
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' })
    };

    await act(async () => {
      dom.window.dispatchEvent(rejectingPromptEvent);
    });
    assert.ok(harness.getHeaderInstallBtn());
    assert.ok(harness.getSidebarInstallBtn());

    let installResult = true;
    await act(async () => {
      installResult = await harness.getHook().install();
    });
    assert.equal(installResult, false);
    assert.equal(failPromptCalls, 1);
    assert.equal(harness.getHook().isInstallable, false);
    assert.equal(harness.getHeaderInstallBtn(), null);
    assert.equal(harness.getSidebarInstallBtn(), null);

    // 2. Rejected userChoice also clears consumed event cleanly
    const rejectedChoice = createDeferred<{ outcome: 'accepted' | 'dismissed'; platform: string }>();
    const badChoiceEvent = {
      type: 'beforeinstallprompt',
      preventDefault() {},
      prompt() {
        return Promise.resolve();
      },
      userChoice: rejectedChoice.promise
    };

    await act(async () => {
      dom.window.dispatchEvent(badChoiceEvent);
    });
    assert.ok(harness.getHeaderInstallBtn());

    await act(async () => {
      const p = harness.getHook().install();
      rejectedChoice.reject(new Error('Browser closed prompt'));
      const ok = await p;
      assert.equal(ok, false);
    });
    assert.equal(harness.getHook().isInstallable, false);
    assert.equal(harness.getHeaderInstallBtn(), null);
    assert.equal(harness.getSidebarInstallBtn(), null);

    // 3. New prompt accepted updates Header (including popover) & Sidebar simultaneously
    const acceptedChoice = createDeferred<{ outcome: 'accepted' | 'dismissed'; platform: string }>();
    const acceptEvent = {
      type: 'beforeinstallprompt',
      preventDefault() {},
      prompt() {
        return Promise.resolve();
      },
      userChoice: acceptedChoice.promise
    };

    await act(async () => {
      dom.window.dispatchEvent(acceptEvent);
    });
    assert.ok(harness.getHeaderInstallBtn());
    assert.ok(harness.getSidebarInstallBtn());

    // Open Header account menu to verify account-popover install button is also synced
    const accountTrigger = dom.findAll(
      (el) => el.tagName === 'BUTTON' && el.classList?.contains('desktop-user-trigger')
    )[0];
    assert.ok(accountTrigger);
    await act(async () => {
      accountTrigger.click();
    });
    const popoverInstallBtn = dom.findAll(
      (el) => el.tagName === 'BUTTON' && el.classList?.contains('account-popover-item-btn') && el.textContent.includes('Install')
    )[0];
    assert.ok(popoverInstallBtn, 'Account popover Install button should be present');

    await act(async () => {
      harness.getHeaderInstallBtn()!.click();
    });
    await act(async () => {
      acceptedChoice.resolve({ outcome: 'accepted', platform: 'web' });
      await Promise.resolve();
    });

    assert.equal(harness.getHook().isInstalled, true);
    assert.equal(harness.getHook().isInstallable, false);
    assert.equal(harness.getHeaderInstallBtn(), null);
    assert.equal(harness.getSidebarInstallBtn(), null);
    assert.equal(
      dom.findAll((el) => el.tagName === 'BUTTON' && el.classList?.contains('account-popover-item-btn') && el.textContent.includes('Install')).length,
      0
    );
  } finally {
    await harness.unmount();
    dom.restore();
  }
});

test('ORVIX-LOW-02: Standalone mode and appinstalled suppress Install buttons everywhere', async () => {
  const dom = createMockDomEnvironment();
  const harness = mountHeaderAndSidebar(dom);

  try {
    await harness.mount();

    await act(async () => {
      dom.window.dispatchEvent({
        type: 'beforeinstallprompt',
        preventDefault() {},
        prompt: async () => {},
        userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' })
      });
    });
    assert.ok(harness.getHeaderInstallBtn());
    assert.ok(harness.getSidebarInstallBtn());

    // External browser installation via appinstalled event clears prompt and hides all Install buttons
    await act(async () => {
      dom.window.dispatchEvent({ type: 'appinstalled' });
    });

    assert.equal(harness.getHook().isInstalled, true);
    assert.equal(harness.getHook().isInstallable, false);
    assert.equal(harness.getHeaderInstallBtn(), null);
    assert.equal(harness.getSidebarInstallBtn(), null);
  } finally {
    await harness.unmount();
    dom.restore();
  }
});
