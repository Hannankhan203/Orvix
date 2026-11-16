import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';
import { SettingsProvider } from '../src/context/SettingsContext.jsx';
import { SpeechProvider } from '../src/context/SpeechContext.jsx';
import MessageErrorBox from '../src/components/chat/MessageErrorBox.jsx';
// Pre-load lazy AuthScreen module so Suspense inside ChatPage resolves cleanly in Node tests
import '../src/components/auth/AuthScreen.jsx';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:pwa-register') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function registerSW() { return () => Promise.resolve(); }'
      };
    }
    return nextResolve(specifier, context);
  }
});

let CachedChatPage: any = null;
async function getChatPage() {
  if (!CachedChatPage) {
    const mod = await import('../src/pages/ChatPage.jsx');
    CachedChatPage = mod.default;
  }
  return CachedChatPage;
}

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

interface FakeEvent {
  type: string;
  target: any;
  currentTarget: any;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  key?: string;
  preventDefault(): void;
  stopPropagation(): void;
}

function createFakeEvent(type: string, target: any, extra: Record<string, any> = {}): FakeEvent {
  return {
    type,
    target,
    currentTarget: target,
    bubbles: extra.bubbles ?? true,
    cancelable: extra.cancelable ?? true,
    defaultPrevented: false,
    propagationStopped: false,
    ...extra,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    }
  };
}

function matchesSimpleSelector(el: any, selector: string): boolean {
  if (!el || el.nodeType !== 1) return false;
  let rest = selector.trim();
  if (!rest) return false;

  const attrMatches: Array<{ key: string; val?: string }> = [];
  rest = rest.replace(/\[([^\]=]+)(?:="([^"]*)")?\]/g, (_m, k, v) => {
    attrMatches.push({ key: k, val: v });
    return '';
  });

  const classMatches: string[] = [];
  rest = rest.replace(/\.([a-zA-Z0-9_-]+)/g, (_m, cls) => {
    classMatches.push(cls);
    return '';
  });

  let idMatch: string | null = null;
  rest = rest.replace(/#([a-zA-Z0-9_-]+)/g, (_m, id) => {
    idMatch = id;
    return '';
  });

  const tagMatch = rest.trim().toUpperCase();
  if (tagMatch && el.tagName !== tagMatch) return false;
  if (idMatch && el.id !== idMatch) return false;

  for (const cls of classMatches) {
    if (!el.classList?.contains(cls)) return false;
  }

  for (const attr of attrMatches) {
    const actual = el.getAttribute(attr.key);
    if (attr.val === undefined) {
      if (actual === null || actual === undefined) return false;
    } else if (String(actual) !== attr.val) {
      return false;
    }
  }

  return true;
}

function walkTree(root: any, predicate: (node: any) => boolean, results: any[] = []): any[] {
  if (!root || !Array.isArray(root.childNodes)) return results;
  for (const child of root.childNodes) {
    if (predicate(child)) {
      results.push(child);
    }
    walkTree(child, predicate, results);
  }
  return results;
}

function getTextContent(node: any): string {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.nodeValue || '');
  if (!Array.isArray(node.childNodes)) return '';
  return node.childNodes.map(getTextContent).join('');
}

function querySelectorAllIn(root: any, selector: string): any[] {
  const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
  return walkTree(root, (el) => parts.some((p) => matchesSimpleSelector(el, p)));
}

function querySelectorIn(root: any, selector: string): any | null {
  const all = querySelectorAllIn(root, selector);
  return all[0] || null;
}

function installRichTestDomEnvironment(options?: {
  sessionStorage?: MockStorage;
  localStorage?: MockStorage;
  pathname?: string;
}) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevSessionStorage = (globalThis as any).sessionStorage;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  const prevFetch = (globalThis as any).fetch;
  const prevHTMLInputElement = (globalThis as any).HTMLInputElement;
  const prevHTMLTextAreaElement = (globalThis as any).HTMLTextAreaElement;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevResizeObserver = (globalThis as any).ResizeObserver;
  const prevIntersectionObserver = (globalThis as any).IntersectionObserver;

  const listenerStore = new WeakMap<object, Map<string, Set<{ fn: Function; capture: boolean }>>>();
  const addEv = (target: object, type: string, fn: Function, opts?: boolean | AddEventListenerOptions) => {
    if (!fn) return;
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
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
    set.add({ fn, capture });
  };
  const removeEv = (target: object, type: string, fn: Function, opts?: boolean | EventListenerOptions) => {
    const map = listenerStore.get(target);
    const set = map?.get(type);
    if (!set) return;
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
    for (const entry of Array.from(set)) {
      if (entry.fn === fn && entry.capture === capture) {
        set.delete(entry);
      }
    }
  };
  const invokeListeners = (node: any, event: FakeEvent, capturePhase: boolean) => {
    const set = listenerStore.get(node)?.get(event.type);
    if (!set) return;
    event.currentTarget = node;
    for (const entry of Array.from(set)) {
      if (entry.capture === capturePhase) {
        entry.fn.call(node, event);
      }
    }
  };

  const dispatchDomEvent = (target: any, event: FakeEvent) => {
    const path: any[] = [];
    let cur = target;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode || (cur === doc ? view : cur === doc.documentElement ? doc : null);
    }
    // Capture phase (window -> document -> ... -> target)
    for (let i = path.length - 1; i >= 0; i--) {
      if (event.propagationStopped) break;
      invokeListeners(path[i], event, true);
    }
    // Bubble phase (target -> ... -> document -> window)
    for (let i = 0; i < path.length; i++) {
      if (event.propagationStopped) break;
      if (i > 0 && !event.bubbles) break;
      invokeListeners(path[i], event, false);
    }
    return !event.defaultPrevented;
  };

  class FakeElement {
    tagName: string;
    nodeType = 1;
    ownerDocument: any;
    parentNode: any = null;
    childNodes: any[] = [];
    attributes = new Map<string, string>();
    style: Record<string, any> = {
      setProperty() {},
      removeProperty() {}
    };
    className = '';
    _value = '';
    _checked = false;
    _selected = false;
    disabled = false;
    type = '';
    id = '';
    htmlFor = '';
    tabIndex = 0;
    scrollTop = 0;
    scrollHeight = 100;
    clientHeight = 100;

    constructor(tag: string, doc: any) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
    }

    get nodeName() {
      return this.tagName;
    }

    get options() {
      return this.childNodes.filter((c) => c.tagName === 'OPTION');
    }

    get selected() {
      return this._selected;
    }

    set selected(v: boolean) {
      this._selected = Boolean(v);
    }

    get value() {
      return this._value;
    }

    set value(v: string) {
      this._value = String(v ?? '');
    }

    get classList() {
      const self = this;
      const getTokens = () =>
        self.className
          .split(/\s+/)
          .map((t) => t.trim())
          .filter(Boolean);
      return {
        add(...tokens: string[]) {
          const set = new Set(getTokens());
          tokens.forEach((t) => set.add(t));
          self.className = Array.from(set).join(' ');
        },
        remove(...tokens: string[]) {
          const rem = new Set(tokens);
          self.className = getTokens().filter((t) => !rem.has(t)).join(' ');
        },
        contains(token: string) {
          return getTokens().includes(token);
        },
        toggle(token: string, force?: boolean) {
          const has = this.contains(token);
          const shouldAdd = force === undefined ? !has : force;
          if (shouldAdd) this.add(token);
          else this.remove(token);
          return shouldAdd;
        }
      };
    }

    get textContent() {
      return getTextContent(this);
    }

    set textContent(val: string) {
      this.childNodes = val ? [this.ownerDocument.createTextNode(String(val))] : [];
    }

    appendChild(c: any) {
      if (c.parentNode && c.parentNode !== this) {
        c.parentNode.removeChild(c);
      }
      if (!this.childNodes.includes(c)) {
        this.childNodes.push(c);
      }
      c.parentNode = this;
      return c;
    }

    removeChild(c: any) {
      this.childNodes = this.childNodes.filter((x) => x !== c);
      if (c.parentNode === this) c.parentNode = null;
      return c;
    }

    insertBefore(c: any, ref: any) {
      if (c.parentNode && c.parentNode !== this) {
        c.parentNode.removeChild(c);
      }
      const existingIdx = this.childNodes.indexOf(c);
      if (existingIdx !== -1) this.childNodes.splice(existingIdx, 1);
      const refIdx = ref ? this.childNodes.indexOf(ref) : -1;
      if (refIdx === -1) {
        this.childNodes.push(c);
      } else {
        this.childNodes.splice(refIdx, 0, c);
      }
      c.parentNode = this;
      return c;
    }

    hasChildNodes() {
      return this.childNodes.length > 0;
    }

    setAttribute(name: string, value: string) {
      const strVal = String(value);
      this.attributes.set(name, strVal);
      if (name === 'class') this.className = strVal;
      else if (name === 'id') this.id = strVal;
      else if (name === 'type') this.type = strVal;
      else if (name === 'disabled') this.disabled = true;
      else if (name === 'value') this._value = strVal;
    }

    getAttribute(name: string) {
      if (name === 'class') return this.className || null;
      if (name === 'id') return this.id || null;
      if (name === 'type') return this.type || null;
      if (name === 'disabled') return this.disabled ? '' : null;
      return this.attributes.has(name) ? this.attributes.get(name)! : null;
    }

    hasAttribute(name: string) {
      return this.getAttribute(name) !== null;
    }

    removeAttribute(name: string) {
      this.attributes.delete(name);
      if (name === 'class') this.className = '';
      else if (name === 'id') this.id = '';
      else if (name === 'disabled') this.disabled = false;
    }

    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(this, type, fn, opts);
    }

    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(this, type, fn, opts);
    }

    dispatchEvent(event: FakeEvent) {
      return dispatchDomEvent(this, event);
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }

    blur() {
      if (this.ownerDocument.activeElement === this) {
        this.ownerDocument.activeElement = null;
      }
    }

    click() {
      if (this.disabled) return;
      const ev = createFakeEvent('click', this);
      dispatchDomEvent(this, ev);
      if (!ev.defaultPrevented && this.tagName === 'BUTTON' && (this.type === 'submit' || !this.type)) {
        const form = this.closest('form');
        if (form) {
          form.dispatchEvent(createFakeEvent('submit', form));
        }
      }
    }

    closest(selector: string) {
      let cur: any = this;
      while (cur && cur.nodeType === 1) {
        if (matchesSimpleSelector(cur, selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }

    contains(other: any) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    scrollIntoView() {}

    getBoundingClientRect() {
      return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
    }

    querySelector(selector: string) {
      return querySelectorIn(this, selector);
    }

    querySelectorAll(selector: string) {
      return querySelectorAllIn(this, selector);
    }
  }

  class FakeHTMLInputElement extends FakeElement {
    type = 'text';
    get value() {
      return this._value;
    }
    set value(v: string) {
      this._value = String(v ?? '');
    }
    get checked() {
      return this._checked;
    }
    set checked(v: boolean) {
      this._checked = Boolean(v);
    }
  }

  class FakeHTMLTextAreaElement extends FakeElement {
    get value() {
      return this._value;
    }
    set value(v: string) {
      this._value = String(v ?? '');
    }
  }

  const sStorage = options?.sessionStorage || createMemoryStorage();
  const lStorage = options?.localStorage || createMemoryStorage();
  const pathname = options?.pathname || '/share/SharedTestConv001';

  const view: any = {
    HTMLIFrameElement: class {},
    HTMLElement: FakeElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
    location: {
      pathname,
      origin: 'http://localhost:3000',
      search: '',
      hash: ''
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    sessionStorage: sStorage,
    localStorage: lStorage,
    navigator: {
      onLine: true,
      standalone: false,
      userAgent: 'node-test',
      clipboard: { writeText: async () => {} }
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    }),
    getSelection: () => ({ toString: () => '' }),
    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(view, type, fn, opts);
    },
    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(view, type, fn, opts);
    },
    dispatchEvent(event: FakeEvent) {
      return dispatchDomEvent(view, event);
    }
  };

  const doc: any = {
    nodeType: 9,
    compatMode: 'CSS1Compat',
    oninput: null,
    onchange: null,
    documentElement: null as any,
    body: null as any,
    defaultView: view,
    activeElement: null,
    visibilityState: 'visible',
    createElement(tag: string) {
      const upper = tag.toUpperCase();
      if (upper === 'INPUT') return new FakeHTMLInputElement(tag, doc);
      if (upper === 'TEXTAREA') return new FakeHTMLTextAreaElement(tag, doc);
      return new FakeElement(tag, doc);
    },
    createElementNS(_ns: string, tag: string) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: String(text), parentNode: null, ownerDocument: doc };
    },
    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(doc, type, fn, opts);
    },
    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(doc, type, fn, opts);
    },
    dispatchEvent(event: FakeEvent) {
      return dispatchDomEvent(doc, event);
    },
    querySelector(selector: string) {
      return querySelectorIn(doc.body, selector) || querySelectorIn(doc.documentElement, selector);
    },
    querySelectorAll(selector: string) {
      return [
        ...querySelectorAllIn(doc.documentElement, selector),
        ...querySelectorAllIn(doc.body, selector)
      ];
    }
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.documentElement.parentNode = doc;
  doc.body = new FakeElement('body', doc);
  doc.body.parentNode = doc.documentElement;
  view.document = doc;

  const container = new FakeElement('div', doc);
  container.id = 'root';
  doc.body.appendChild(container);

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = view;
  (globalThis as any).document = doc;
  (globalThis as any).sessionStorage = sStorage;
  (globalThis as any).localStorage = lStorage;
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLInputElement = FakeHTMLInputElement;
  (globalThis as any).HTMLTextAreaElement = FakeHTMLTextAreaElement;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: {} })
  });

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

    if (prevFetch === undefined) delete (globalThis as any).fetch;
    else (globalThis as any).fetch = prevFetch;

    if (prevHTMLElement === undefined) delete (globalThis as any).HTMLElement;
    else (globalThis as any).HTMLElement = prevHTMLElement;

    if (prevHTMLInputElement === undefined) delete (globalThis as any).HTMLInputElement;
    else (globalThis as any).HTMLInputElement = prevHTMLInputElement;

    if (prevHTMLTextAreaElement === undefined) delete (globalThis as any).HTMLTextAreaElement;
    else (globalThis as any).HTMLTextAreaElement = prevHTMLTextAreaElement;

    if (prevResizeObserver === undefined) delete (globalThis as any).ResizeObserver;
    else (globalThis as any).ResizeObserver = prevResizeObserver;

    if (prevIntersectionObserver === undefined) delete (globalThis as any).IntersectionObserver;
    else (globalThis as any).IntersectionObserver = prevIntersectionObserver;
  };

  const setInputValue = async (inputEl: any, nextValue: string) => {
    const proto =
      inputEl.tagName === 'TEXTAREA' ? FakeHTMLTextAreaElement.prototype : FakeHTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    await act(async () => {
      descriptor?.set?.call(inputEl, nextValue);
      inputEl.dispatchEvent(createFakeEvent('input', inputEl));
      inputEl.dispatchEvent(createFakeEvent('change', inputEl));
    });
  };

  return {
    window: view,
    document: doc,
    container,
    sessionStorage: sStorage,
    localStorage: lStorage,
    setInputValue,
    query: (selector: string) => querySelectorIn(container, selector),
    queryAll: (selector: string) => querySelectorAllIn(container, selector),
    restore
  };
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
  let failNextLogin = false;

  const notifyAll = (user: FakeUser | null) => {
    for (const listener of Array.from(activeListeners)) {
      listener(user);
    }
  };

  const authDeps = {
    isFirebaseConfigured: () => true,
    isBrowserOnline: () => true,
    onAuthChange: (cb: (user: FakeUser | null) => void) => {
      activeListeners.add(cb);
      queueMicrotask(() => {
        if (activeListeners.has(cb)) {
          cb(persistedUser);
        }
      });
      return () => {
        activeListeners.delete(cb);
      };
    },
    loginWithEmail: async (email: string, _password: string) => {
      if (failNextLogin) {
        failNextLogin = false;
        const err: any = new Error('Invalid credentials');
        err.code = 'auth/invalid-credential';
        throw err;
      }
      const uid = `fb-${email.trim().toLowerCase()}`;
      const existingProfile = profiles.get(uid);
      const user: FakeUser = {
        uid,
        email: email.trim(),
        displayName: existingProfile?.username || 'Signed In User'
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
    setFailNextLogin(fail: boolean) {
      failNextLogin = fail;
    },
    getListenerCount() {
      return activeListeners.size;
    }
  };
}

function buildValidSharedSnapshot(shareId = 'SharedTestConv001') {
  return {
    id: shareId,
    title: 'Shared Quantum Summary',
    mode: 'general',
    messageCount: 2,
    messages: [
      {
        id: 'shared-msg-1',
        sender: 'user',
        content: 'Explain superposition briefly.',
        createdAtMs: 1700000001000
      },
      {
        id: 'shared-msg-2',
        sender: 'assistant',
        content: 'Superposition allows a quantum state to exist as a linear combination of basis states.',
        modelUsed: 'gemini-2.5-flash',
        provider: 'gemini',
        mode: 'general',
        createdAtMs: 1700000002000
      }
    ]
  };
}

interface AuthContextValue {
  currentUser: FakeUser | null;
  username: string;
  initialLoading: boolean;
  error: string | null;
  signup: (email: string, password: string, username: string) => Promise<FakeUser>;
  login: (email: string, password: string) => Promise<FakeUser>;
  logout: () => Promise<void>;
  continueAsGuest: (preferredName?: string | null) => void;
}

async function flushAsync(ms = 25) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function mountSharedChatHarness(
  dom: ReturnType<typeof installRichTestDomEnvironment>,
  authDeps: any,
  shareId = 'SharedTestConv001'
) {
  const { createRoot } = await import('react-dom/client');
  const ChatPageComponent = await getChatPage();
  let latestAuth: AuthContextValue | null = null;

  function AuthObserver() {
    latestAuth = useAuth() as unknown as AuthContextValue;
    return null;
  }

  const root: Root = createRoot(dom.container as unknown as Element);
  const tree = React.createElement(
    AuthProvider as any,
    { authDeps },
    React.createElement(
      SettingsProvider as any,
      null,
      React.createElement(
        SpeechProvider as any,
        null,
        React.createElement(AuthObserver),
        React.createElement(ChatPageComponent, {
          isSharedView: true,
          sharedShareId: shareId,
          rawShareId: shareId,
          isMalformedShareId: false,
          onNavigateHome: () => {}
        })
      )
    )
  );

  return {
    async mount() {
      await act(async () => {
        root.render(tree);
      });
      await flushAsync(40);
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
    getAuth(): AuthContextValue {
      assert.ok(latestAuth, 'Auth context should be mounted');
      return latestAuth;
    }
  };
}

test('HIGH-02: Unauthenticated visitor on shared conversation can open, close (X/Escape/backdrop), handle errors, and continue as Guest cleanly', async () => {
  const shareId = 'SharedTestConv001';
  const sessionStorage = createMemoryStorage({
    [`orvix_shared_snapshot_${shareId}`]: JSON.stringify(buildValidSharedSnapshot(shareId))
  });
  const localStorage = createMemoryStorage();
  const dom = installRichTestDomEnvironment({
    sessionStorage,
    localStorage,
    pathname: `/share/${shareId}`
  });
  const fb = createFakeFirebaseController(null);
  const harness = await mountSharedChatHarness(dom, fb.authDeps, shareId);

  try {
    await harness.mount();

    // Shared conversation & read-only banner should be rendered for unauthenticated visitor
    assert.equal(harness.getAuth().currentUser, null);
    const banner = dom.query('[aria-label="Shared conversation banner"]');
    assert.ok(banner, 'SharedConversationBanner should render');
    assert.ok(banner.textContent.includes('Shared Conversation · Read Only'));
    const signInBtn = dom.query('.shared-banner-signin-btn');
    assert.ok(signInBtn, 'Sign In button should be visible for unauthenticated visitor');
    assert.ok(dom.container.textContent.includes('Explain superposition briefly.'));
    assert.equal(dom.queryAll('[role="dialog"]').length, 0);

    // 1. Open modal via Sign In button -> close via X button
    await act(async () => {
      signInBtn.click();
    });
    await flushAsync(20);
    assert.equal(dom.queryAll('[role="dialog"]').length, 1, 'Auth modal should open');
    assert.ok(dom.query('.auth-guest-btn'), 'Unauthenticated modal should offer Continue as Guest');
    const closeBtn = dom.query('button[aria-label="Close authentication dialog"]');
    assert.ok(closeBtn, 'Close X button should render');
    await act(async () => {
      closeBtn.click();
    });
    assert.equal(dom.queryAll('[role="dialog"]').length, 0, 'X button should close modal');

    // 2. Reopen modal -> close via Escape key
    await act(async () => {
      signInBtn.click();
    });
    await flushAsync(20);
    assert.equal(dom.queryAll('[role="dialog"]').length, 1);
    await act(async () => {
      dom.window.dispatchEvent(createFakeEvent('keydown', dom.window, { key: 'Escape' }));
    });
    assert.equal(dom.queryAll('[role="dialog"]').length, 0, 'Escape key should close modal');

    // 3. Failed login shows error, closing via backdrop clears stale error on next open
    fb.setFailNextLogin(true);
    await act(async () => {
      signInBtn.click();
    });
    await flushAsync(20);
    await dom.setInputValue(dom.query('#auth-email'), 'visitor@example.com');
    await dom.setInputValue(dom.query('#auth-password'), 'wrongpass');
    await act(async () => {
      dom.query('.auth-form').dispatchEvent(createFakeEvent('submit', dom.query('.auth-form')));
    });
    await flushAsync(20);
    assert.ok(dom.query('.auth-error-alert'), 'Failed login should display error inside modal');

    const overlay = dom.query('.shared-auth-modal-overlay');
    assert.ok(overlay);
    await act(async () => {
      overlay.dispatchEvent(createFakeEvent('click', overlay));
    });
    assert.equal(dom.queryAll('[role="dialog"]').length, 0, 'Backdrop click should close modal');

    // Reopen -> stale error should be cleared
    await act(async () => {
      signInBtn.click();
    });
    await flushAsync(20);
    assert.equal(dom.query('.auth-error-alert'), null, 'Reopened modal should not show stale error');

    // 4. Continue as Guest closes modal and keeps read-only shared view
    const guestBtn = dom.query('.auth-guest-btn');
    assert.ok(guestBtn);
    await act(async () => {
      guestBtn.click();
    });
    assert.equal(dom.queryAll('[role="dialog"]').length, 0, 'Continue as Guest should dismiss modal');
    assert.equal(harness.getAuth().currentUser?.isAnonymous, true);
    assert.ok(dom.query('.shared-banner-signin-btn'), 'Sign In button must remain visible for guest viewer');
    assert.ok(banner.textContent.includes('Shared Conversation · Read Only'));

    await harness.unmount();
  } finally {
    dom.restore();
  }
});

test('HIGH-02: Guest Mode user (including reloaded guest session) can open Sign-In modal from SharedConversationBanner, cancel safely, and sign in to Firebase', async () => {
  const shareId = 'SharedTestConv002';
  const existingGuest = {
    uid: 'guest-shared77',
    email: 'guest@orvix.ai',
    displayName: 'Guest Reader',
    username: 'Guest Reader',
    isAnonymous: true
  };
  const sessionStorage = createMemoryStorage({
    orvix_guest_session: JSON.stringify(existingGuest),
    [`orvix_shared_snapshot_${shareId}`]: JSON.stringify(buildValidSharedSnapshot(shareId))
  });
  const localStorage = createMemoryStorage({
    orvix_guest_session: JSON.stringify(existingGuest)
  });
  const dom = installRichTestDomEnvironment({
    sessionStorage,
    localStorage,
    pathname: `/share/${shareId}`
  });
  const fb = createFakeFirebaseController(null);
  const harness = await mountSharedChatHarness(dom, fb.authDeps, shareId);

  try {
    await harness.mount();

    // Guest session restored cleanly; HIGH-01 onAuthChange subscription active
    assert.equal(harness.getAuth().currentUser?.uid, 'guest-shared77');
    assert.equal(harness.getAuth().currentUser?.isAnonymous, true);
    assert.equal(fb.getListenerCount(), 1);

    // SharedConversationBanner displays read-only banner + Sign In button
    const banner = dom.query('[aria-label="Shared conversation banner"]');
    assert.ok(banner);
    assert.ok(banner.textContent.includes('Shared Conversation · Read Only'));
    const signInBtn = dom.query('.shared-banner-signin-btn');
    assert.ok(signInBtn, 'Guest viewer must see Sign In button');

    // Read-only composer restriction enforced for guest viewer
    const composerTextareaBefore = dom.query('.composer-textarea');
    assert.ok(composerTextareaBefore, 'Composer textarea exists');
    assert.equal(composerTextareaBefore.disabled, true, 'Guest shared viewer composer must remain read-only');

    // Click Sign In -> HIGH-02 BUG FIX CHECK: modal MUST open for Guest Mode user!
    await act(async () => {
      signInBtn.click();
    });
    await flushAsync(30);

    const dialogs = dom.queryAll('[role="dialog"][aria-label="Sign In"]');
    assert.equal(dialogs.length, 1, 'Sign In modal must open for Guest Mode user without duplicates');
    assert.ok(dom.query('.auth-form'), 'AuthScreen form should render inside modal');
    assert.equal(dom.query('.auth-guest-btn'), null, 'Redundant Continue as Guest option should be hidden for active guest');

    // Close / cancel modal preserves guest session and read-only shared view
    await act(async () => {
      dom.query('button[aria-label="Close authentication dialog"]').click();
    });
    assert.equal(dom.queryAll('[role="dialog"]').length, 0);
    assert.equal(harness.getAuth().currentUser?.uid, 'guest-shared77');
    assert.ok(localStorage.getItem('orvix_guest_session'), 'Cancelling modal must not wipe guest session');
    assert.equal(dom.query('.composer-textarea').disabled, true);

    // Reopen modal -> Sign in as Firebase user
    await act(async () => {
      dom.query('.shared-banner-signin-btn').click();
    });
    await flushAsync(20);
    assert.equal(dom.queryAll('[role="dialog"]').length, 1);

    await dom.setInputValue(dom.query('#auth-email'), 'guest.upgraded@example.com');
    await dom.setInputValue(dom.query('#auth-password'), 'secret123');
    await act(async () => {
      dom.query('.auth-form').dispatchEvent(createFakeEvent('submit', dom.query('.auth-form')));
    });
    await flushAsync(30);

    // Verify clean transition from guest -> authenticated Firebase user
    assert.equal(harness.getAuth().currentUser?.email, 'guest.upgraded@example.com');
    assert.equal(harness.getAuth().currentUser?.isAnonymous, undefined);
    assert.equal(sessionStorage.getItem('orvix_guest_session'), null);
    assert.equal(localStorage.getItem('orvix_guest_session'), null);

    // Modal closed automatically, banner updated to interactive Preview, Sign In hidden
    assert.equal(dom.queryAll('[role="dialog"]').length, 0, 'Modal should close automatically on sign-in');
    assert.ok(
      dom.query('[aria-label="Shared conversation banner"]').textContent.includes('Shared Conversation · Preview')
    );
    assert.equal(dom.query('.shared-banner-signin-btn'), null, 'Authenticated user should not see Sign In button');

    // Shared conversation messages remain intact & composer becomes interactive
    assert.ok(dom.container.textContent.includes('Explain superposition briefly.'));
    assert.equal(dom.query('.composer-textarea').disabled, false, 'Authenticated preview enables composer');

    // Signing out later must NOT resurrect an open modal (showAuthModal stays false)
    await act(async () => {
      await harness.getAuth().logout();
    });
    await flushAsync(20);
    assert.equal(harness.getAuth().currentUser, null);
    assert.equal(dom.queryAll('[role="dialog"]').length, 0, 'Logout must not reopen stale auth modal');
    assert.ok(dom.query('.shared-banner-signin-btn'), 'Sign In button reappears after logout');
    assert.equal(dom.query('.composer-textarea').disabled, true, 'Composer returns to read-only after logout');

    await harness.unmount();
    assert.equal(fb.getListenerCount(), 0);
  } finally {
    dom.restore();
  }
});

test('HIGH-02: Guest Mode user can switch to Create Account tab inside shared modal and register cleanly', async () => {
  const shareId = 'SharedTestConv003';
  const existingGuest = {
    uid: 'guest-signup88',
    email: 'guest@orvix.ai',
    displayName: 'Guest Signup',
    username: 'Guest Signup',
    isAnonymous: true
  };
  const sessionStorage = createMemoryStorage({
    orvix_guest_session: JSON.stringify(existingGuest),
    [`orvix_shared_snapshot_${shareId}`]: JSON.stringify(buildValidSharedSnapshot(shareId))
  });
  const localStorage = createMemoryStorage({
    orvix_guest_session: JSON.stringify(existingGuest)
  });
  const dom = installRichTestDomEnvironment({
    sessionStorage,
    localStorage,
    pathname: `/share/${shareId}`
  });
  const fb = createFakeFirebaseController(null);
  const harness = await mountSharedChatHarness(dom, fb.authDeps, shareId);

  try {
    await harness.mount();

    // Open modal from shared conversation banner
    await act(async () => {
      dom.query('.shared-banner-signin-btn').click();
    });
    await flushAsync(20);
    assert.equal(dom.queryAll('[role="dialog"]').length, 1);

    // Switch to Create Account tab
    const tabs = dom.queryAll('button[role="tab"]');
    const createAccountTab = tabs.find((t) => t.textContent.includes('Create Account'));
    assert.ok(createAccountTab, 'Create Account tab should exist');
    await act(async () => {
      createAccountTab.click();
    });

    const usernameInput = dom.query('#auth-username');
    assert.ok(usernameInput, 'Username input should appear in signup mode');
    await dom.setInputValue(usernameInput, 'OrvixCreator');
    await dom.setInputValue(dom.query('#auth-email'), 'creator@example.com');
    await dom.setInputValue(dom.query('#auth-password'), 'strongpass99');

    await act(async () => {
      dom.query('.auth-form').dispatchEvent(createFakeEvent('submit', dom.query('.auth-form')));
    });
    await flushAsync(30);

    // Registration completes, clears guest state, closes modal, preserves shared conversation
    assert.equal(harness.getAuth().currentUser?.email, 'creator@example.com');
    assert.equal(harness.getAuth().username, 'OrvixCreator');
    assert.equal(sessionStorage.getItem('orvix_guest_session'), null);
    assert.equal(localStorage.getItem('orvix_guest_session'), null);
    assert.equal(dom.queryAll('[role="dialog"]').length, 0);
    assert.equal(dom.query('.shared-banner-signin-btn'), null);
    assert.ok(
      dom.query('[aria-label="Shared conversation banner"]').textContent.includes('Shared Conversation · Preview')
    );
    assert.ok(dom.container.textContent.includes('Explain superposition briefly.'));

    await harness.unmount();
  } finally {
    dom.restore();
  }
});

test('HIGH-02: Authenticated Firebase user viewing a shared conversation sees Preview banner without Sign-In button or auth modal', async () => {
  const shareId = 'SharedTestConv004';
  const sessionStorage = createMemoryStorage({
    [`orvix_shared_snapshot_${shareId}`]: JSON.stringify(buildValidSharedSnapshot(shareId))
  });
  const localStorage = createMemoryStorage();
  const dom = installRichTestDomEnvironment({
    sessionStorage,
    localStorage,
    pathname: `/share/${shareId}`
  });
  const fb = createFakeFirebaseController({
    uid: 'fb-authed-user',
    email: 'authed@example.com',
    displayName: 'AuthedUser'
  });
  const harness = await mountSharedChatHarness(dom, fb.authDeps, shareId);

  try {
    await harness.mount();

    assert.equal(harness.getAuth().currentUser?.uid, 'fb-authed-user');
    const banner = dom.query('[aria-label="Shared conversation banner"]');
    assert.ok(banner);
    assert.ok(banner.textContent.includes('Shared Conversation · Preview'));
    assert.equal(dom.query('.shared-banner-signin-btn'), null, 'Authenticated user should not see Sign In button');
    assert.equal(dom.queryAll('[role="dialog"]').length, 0, 'Authenticated user must never see auth modal');
    assert.equal(dom.query('.composer-textarea').disabled, false);

    await harness.unmount();
  } finally {
    dom.restore();
  }
});

test('HIGH-03: MessageErrorBox suppresses futile retry on auth error and renders Sign In to Use Cloud AI button', async () => {
  const sessionStorage = createMemoryStorage();
  const localStorage = createMemoryStorage();
  const dom = installRichTestDomEnvironment({ sessionStorage, localStorage, pathname: '/' });
  const { createRoot } = await import('react-dom/client');

  const errorMsg = {
    id: 'err-auth-99',
    isError: true,
    errorCode: 'AUTH_REQUIRED',
    content: 'Cloud request failed: 401 Unauthorized. Authentication required.'
  };

  let signInClicked = false;
  let retryCalled = false;

  const errorBoxEl = React.createElement(MessageErrorBox, {
    message: errorMsg,
    currentProviderId: 'gemini',
    currentProviderObj: { id: 'gemini', name: 'Gemini' },
    fallbackProviders: [{ id: 'webllm', name: 'Browser AI (WebLLM)' }] as any,
    onRetry: () => {
      retryCalled = true;
    },
    onSwitchProvider: () => {},
    onRestorePrompt: () => {},
    onSignInClick: () => {
      signInClicked = true;
    }
  });

  const root = createRoot(dom.container as unknown as Element);
  await act(async () => {
    root.render(errorBoxEl);
  });

  const textContent = dom.container.textContent;
  assert.ok(textContent.includes('Sign In to Use Cloud AI'), 'Sign In to Use Cloud AI button should render');
  assert.equal(retryCalled, false, 'Futile retry should be suppressed for auth errors');

  const signinBtn = dom.query('.error-signin-btn');
  assert.ok(signinBtn);
  await act(async () => {
    signinBtn.click();
  });
  assert.equal(signInClicked, true, 'Clicking Sign In button should invoke callback');

  await act(async () => {
    root.unmount();
  });
  dom.restore();
});

