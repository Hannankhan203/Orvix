import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import UserInlineEditor from '../src/components/chat/UserInlineEditor.jsx';
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';
import { SettingsProvider } from '../src/context/SettingsContext.jsx';
import { SpeechProvider } from '../src/context/SpeechContext.jsx';
import '../src/components/auth/AuthScreen.jsx';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'virtual:pwa-register') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,export function registerSW() { return () => Promise.resolve(); }'
        };
      }
      return nextResolve(specifier, context);
    }
  `),
  import.meta.url
);

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

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installInlineEditorDom(options?: {
  online?: boolean;
  localStorage?: MockStorage;
  sessionStorage?: MockStorage;
}) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevSessionStorage = (globalThis as any).sessionStorage;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  const prevFetch = (globalThis as any).fetch;
  const prevResizeObserver = (globalThis as any).ResizeObserver;
  const prevIntersectionObserver = (globalThis as any).IntersectionObserver;
  const prevHTMLInputElement = (globalThis as any).HTMLInputElement;
  const prevHTMLTextAreaElement = (globalThis as any).HTMLTextAreaElement;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevRAF = (globalThis as any).requestAnimationFrame;
  const prevCAF = (globalThis as any).cancelAnimationFrame;

  const listenerStore = new WeakMap<object, Map<string, Set<{ fn: Function; capture: boolean }>>>();
  const addEv = (target: object, type: string, fn: Function, opts?: any) => {
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
  const removeEv = (target: object, type: string, fn: Function, opts?: any) => {
    const map = listenerStore.get(target)?.get(type);
    if (!map) return;
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
    for (const entry of Array.from(map)) {
      if (entry.fn === fn && entry.capture === capture) map.delete(entry);
    }
  };

  let onlineState = options?.online ?? true;

  class FakeElement {
    tagName: string;
    nodeType = 1;
    ownerDocument: any;
    parentNode: any = null;
    childNodes: any[] = [];
    attributes = new Map<string, string>();
    style: Record<string, any> = { setProperty() {}, removeProperty() {} };
    className = '';
    _value = '';
    disabled = false;
    type = '';
    id = '';
    scrollHeight = 80;
    scrollTop = 0;
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

    get value() {
      return this._value;
    }

    set value(v: string) {
      this._value = String(v ?? '');
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
      const ex = this.childNodes.indexOf(c);
      if (ex !== -1) this.childNodes.splice(ex, 1);
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
      else if (k === 'value') this._value = sv;
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

    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(this, type, fn, opts);
    }

    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(this, type, fn, opts);
    }

    attachEvent() {}

    detachEvent() {}

    dispatchEvent(ev: any) {
      if (!ev.target) ev.target = this;
      const path: any[] = [];
      let cur: any = this;
      while (cur) {
        path.push(cur);
        cur = cur.parentNode || (cur === doc ? view : cur === doc.documentElement ? doc : null);
      }
      for (let i = path.length - 1; i >= 0; i--) {
        if (ev.propagationStopped) break;
        ev.currentTarget = path[i];
        const set = listenerStore.get(path[i])?.get(ev.type);
        if (set) {
          for (const entry of Array.from(set)) {
            if (entry.capture) entry.fn.call(path[i], ev);
          }
        }
      }
      for (let i = 0; i < path.length; i++) {
        if (ev.propagationStopped) break;
        if (i > 0 && !ev.bubbles) break;
        ev.currentTarget = path[i];
        const set = listenerStore.get(path[i])?.get(ev.type);
        if (set) {
          for (const entry of Array.from(set)) {
            if (!entry.capture) entry.fn.call(path[i], ev);
          }
        }
      }
      return !ev.defaultPrevented;
    }

    click() {
      this.dispatchEvent({
        type: 'click',
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        }
      });
    }

    focus() {
      const changed = doc.activeElement !== this;
      doc.activeElement = this;
      if (changed) {
        this.dispatchEvent({
          type: 'focus',
          bubbles: false,
          cancelable: false,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() {},
          stopPropagation() {}
        });
        this.dispatchEvent({
          type: 'focusin',
          bubbles: true,
          cancelable: false,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() {},
          stopPropagation() {}
        });
      }
    }

    setSelectionRange() {}

    scrollIntoView() {}

    closest() {
      return null;
    }

    contains(node: any): boolean {
      if (node === this) return true;
      return this.childNodes.some((c) => (typeof c.contains === 'function' ? c.contains(node) : c === node));
    }

    querySelectorAll() {
      return [];
    }
  }

  class FakeHTMLInputElement extends FakeElement {}
  class FakeHTMLTextAreaElement extends FakeElement {}

  const fakeNavigator: any = {
    get onLine() {
      return onlineState;
    },
    userAgent: 'NodeTest/1.0'
  };

  const view: any = {
    innerWidth: 1280,
    innerHeight: 800,
    navigator: fakeNavigator,
    HTMLIFrameElement: class {},
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    HTMLElement: FakeElement,
    location: { pathname: '/', origin: 'http://localhost:3000', href: 'http://localhost:3000/' },
    history: { pushState() {} },
    matchMedia: () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {}
    }),
    getSelection: () => ({
      rangeCount: 0,
      toString: () => ''
    }),
    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(this, type, fn, opts);
    },
    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(this, type, fn, opts);
    },
    dispatchEvent(ev: any) {
      const set = listenerStore.get(this)?.get(ev.type);
      if (set) {
        for (const entry of Array.from(set)) entry.fn.call(this, ev);
      }
      return true;
    }
  };

  const doc: any = {
    nodeType: 9,
    compatMode: 'CSS1Compat',
    oninput: null,
    documentElement: null as any,
    body: null as any,
    defaultView: view,
    activeElement: null,
    visibilityState: 'visible',
    createElement(tag: string) {
      const t = tag.toLowerCase();
      if (t === 'textarea') return new FakeHTMLTextAreaElement(tag, doc);
      if (t === 'input') return new FakeHTMLInputElement(tag, doc);
      return new FakeElement(tag, doc);
    },
    createElementNS(_ns: string, tag: string) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: text, textContent: text, ownerDocument: doc, parentNode: null };
    },
    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(this, type, fn, opts);
    },
    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(this, type, fn, opts);
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    }
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);

  const sStorage = options?.sessionStorage || createMemoryStorage();
  const lStorage = options?.localStorage || createMemoryStorage();
  view.sessionStorage = sStorage;
  view.localStorage = lStorage;
  view.document = doc;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = view;
  (globalThis as any).document = doc;
  (globalThis as any).sessionStorage = sStorage;
  (globalThis as any).localStorage = lStorage;
  Object.defineProperty(globalThis, 'navigator', {
    value: fakeNavigator,
    configurable: true,
    writable: true
  });
  (globalThis as any).HTMLInputElement = FakeHTMLInputElement;
  (globalThis as any).HTMLTextAreaElement = FakeHTMLTextAreaElement;
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).requestAnimationFrame = (cb: Function) => setTimeout(() => cb(Date.now()), 0);
  (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };

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

    if (prevNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', prevNavigatorDescriptor);
    }

    if (prevFetch === undefined) delete (globalThis as any).fetch;
    else (globalThis as any).fetch = prevFetch;

    if (prevResizeObserver === undefined) delete (globalThis as any).ResizeObserver;
    else (globalThis as any).ResizeObserver = prevResizeObserver;

    if (prevIntersectionObserver === undefined) delete (globalThis as any).IntersectionObserver;
    else (globalThis as any).IntersectionObserver = prevIntersectionObserver;

    if (prevHTMLInputElement === undefined) delete (globalThis as any).HTMLInputElement;
    else (globalThis as any).HTMLInputElement = prevHTMLInputElement;

    if (prevHTMLTextAreaElement === undefined) delete (globalThis as any).HTMLTextAreaElement;
    else (globalThis as any).HTMLTextAreaElement = prevHTMLTextAreaElement;

    if (prevHTMLElement === undefined) delete (globalThis as any).HTMLElement;
    else (globalThis as any).HTMLElement = prevHTMLElement;

    if (prevRAF === undefined) delete (globalThis as any).requestAnimationFrame;
    else (globalThis as any).requestAnimationFrame = prevRAF;

    if (prevCAF === undefined) delete (globalThis as any).cancelAnimationFrame;
    else (globalThis as any).cancelAnimationFrame = prevCAF;
  };

  return {
    window: view,
    container,
    localStorage: lStorage,
    sessionStorage: sStorage,
    findAll,
    setOnline(nextOnline: boolean) {
      onlineState = nextOnline;
      view.dispatchEvent({ type: nextOnline ? 'online' : 'offline' });
    },
    restore
  };
}

function pressKey(el: any, key: string, extras: Record<string, any> = {}) {
  el.dispatchEvent({
    type: 'keydown',
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...extras
  });
}

test('ORVIX-LOW-03: UserInlineEditor unlocks on early return, failure, abort, and rejection while blocking concurrent duplicates', async () => {
  const dom = installInlineEditorDom();
  const root: Root = createRoot(dom.container as any);

  let mode: 'early' | 'reject' | 'abort' | 'syncThrow' | 'pending' | 'success' = 'early';
  let deferredPending = createDeferred<boolean>();
  const calls: Array<{ id: string; text: string }> = [];

  const onEditResend = async (msgId: string, text: string) => {
    calls.push({ id: msgId, text });
    if (mode === 'early') return false;
    if (mode === 'reject') throw new Error('Network unavailable');
    if (mode === 'abort') throw new DOMException('Request aborted', 'AbortError');
    if (mode === 'syncThrow') {
      throw new TypeError('Unexpected failure');
    }
    if (mode === 'pending') return deferredPending.promise;
    return true;
  };

  try {
    await act(async () => {
      root.render(
        React.createElement(UserInlineEditor as any, {
          messageId: 'msg-1',
          initialContent: 'Edited prompt',
          isLoading: false,
          onCancelEdit: () => {},
          onEditResend
        })
      );
    });

    const getSaveBtn = () =>
      dom.findAll((el) => el.tagName === 'BUTTON' && el.classList?.contains('user-edit-resend-btn'))[0];
    const getTextarea = () =>
      dom.findAll((el) => el.tagName === 'TEXTAREA' && el.classList?.contains('user-edit-textarea'))[0];

    // 1. Early return (e.g., offline provider guard) unlocks editor cleanly
    mode = 'early';
    await act(async () => {
      getSaveBtn().click();
    });
    assert.equal(calls.length, 1);
    assert.equal(getSaveBtn().disabled, false);
    assert.equal(getTextarea().disabled, false);

    // 2. Async rejection unlocks editor cleanly without cancel/reopen
    mode = 'reject';
    await act(async () => {
      getSaveBtn().click();
    });
    assert.equal(calls.length, 2);
    assert.equal(getSaveBtn().disabled, false);

    // 3. AbortError unlocks editor cleanly
    mode = 'abort';
    await act(async () => {
      pressKey(getTextarea(), 'Enter');
    });
    assert.equal(calls.length, 3);
    assert.equal(getSaveBtn().disabled, false);

    // 4. Synchronous throw wrapper (non-async callback throwing) unlocks cleanly
    await act(async () => {
      root.render(
        React.createElement(UserInlineEditor as any, {
          messageId: 'msg-1',
          initialContent: 'Edited prompt',
          isLoading: false,
          onCancelEdit: () => {},
          onEditResend: (msgId: string, text: string) => {
            calls.push({ id: msgId, text });
            if (mode === 'syncThrow') throw new Error('Sync failure');
            if (mode === 'pending') return deferredPending.promise;
            return true;
          }
        })
      );
    });
    mode = 'syncThrow';
    await act(async () => {
      getSaveBtn().click();
    });
    assert.equal(calls.length, 4);
    assert.equal(getSaveBtn().disabled, false);

    // 5. While valid async submission is actually in flight, duplicate clicks/Enters are blocked
    mode = 'pending';
    deferredPending = createDeferred<boolean>();
    await act(async () => {
      getSaveBtn().click();
    });
    assert.equal(calls.length, 5);
    assert.equal(getSaveBtn().disabled, true, 'Button must stay disabled while async submission is active');

    await act(async () => {
      getSaveBtn().click();
      pressKey(getTextarea(), 'Enter');
      pressKey(getTextarea(), 'Enter', { ctrlKey: true });
    });
    assert.equal(calls.length, 5, 'Duplicate submissions must be blocked while in flight');

    // Once settled, lock releases and retry succeeds
    await act(async () => {
      deferredPending.resolve(false);
    });
    assert.equal(getSaveBtn().disabled, false);

    mode = 'success';
    await act(async () => {
      getSaveBtn().click();
    });
    assert.equal(calls.length, 6);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test('ORVIX-LOW-03: ChatPage offline-provider rejection on edit does not permanently lock editor; retry succeeds on reconnect and after switching to Browser AI', async () => {
  const guestChats = [
    {
      id: 'guest-chat-1',
      title: 'Test Edit Chat',
      mode: 'general',
      timestamp: 'Just now',
      rawUpdatedAt: Date.now(),
      isPinned: false,
      messages: [
        {
          id: 'u-1',
          sender: 'user',
          content: 'Original question',
          timestamp: '10:00 AM'
        },
        {
          id: 'a-1',
          sender: 'assistant',
          parentMessageId: 'u-1',
          content: 'Original answer',
          timestamp: '10:00 AM'
        }
      ]
    }
  ];

  // Signed-in-like local config with Gemini selected while initially offline
  const localStorage = createMemoryStorage({
    orvix_guest_chats: JSON.stringify(guestChats),
    orvix_selected_provider: 'gemini'
  });
  const sessionStorage = createMemoryStorage({
    orvix_active_chat: 'guest-chat-1'
  });

  const dom = installInlineEditorDom({ online: false, localStorage, sessionStorage });
  const fetchUrls: string[] = [];

  // Mock fetch for /api/chat streaming response once online
  (globalThis as any).fetch = async (url: string) => {
    fetchUrls.push(String(url));
    const ssePayload = `data: ${JSON.stringify({ content: 'Retried online answer' })}\n\ndata: [DONE]\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      }
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream
    };
  };

  // Registered user object (non-guest so selectedProvider stays 'gemini', while firebase is unconfigured -> local fallback chats + online /api/chat fetch)
  const testUser = { uid: 'user-edit-1', email: 'editor@example.com', displayName: 'Editor' };
  const authDeps = {
    isFirebaseConfigured: () => false,
    isBrowserOnline: () => dom.window.navigator.onLine,
    onAuthChange: (cb: (u: any) => void) => {
      cb(testUser);
      return () => {};
    },
    loginWithEmail: async () => ({ user: testUser }),
    signupWithEmail: async () => ({ user: testUser }),
    logout: async () => {},
    getUserProfile: async () => null,
    saveUserProfile: async () => {}
  };

  const ChatPage = await getChatPage();
  function AuthReadyChatPage() {
    const { currentUser, initialLoading } = useAuth();
    if (initialLoading || !currentUser) return null;
    return React.createElement(ChatPage);
  }

  const root: Root = createRoot(dom.container as any);

  try {
    await act(async () => {
      root.render(
        React.createElement(
          AuthProvider as any,
          { authDeps },
          React.createElement(
            SettingsProvider as any,
            { settingsDeps: { loadSettings: async () => ({}), saveSettings: async () => ({}) } },
            React.createElement(
              SpeechProvider as any,
              null,
              React.createElement(AuthReadyChatPage)
            )
          )
        )
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 1. Open inline editor on u-1 while offline with Gemini selected
    const editTrigger = dom.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Edit message'
    )[0];
    assert.ok(editTrigger, 'Edit message button should be rendered');
    await act(async () => {
      editTrigger.click();
    });

    const getSaveBtn = () =>
      dom.findAll((el) => el.tagName === 'BUTTON' && el.classList?.contains('user-edit-resend-btn'))[0];
    const getTextarea = () =>
      dom.findAll((el) => el.tagName === 'TEXTAREA' && el.classList?.contains('user-edit-textarea'))[0];

    assert.ok(getSaveBtn(), 'Inline editor should be open');

    // Attempt Save & Resend while offline with Gemini -> rejected by offline guard
    await act(async () => {
      getSaveBtn().click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Offline banner shown, editor stayed open, AND Save & Resend is NOT stuck disabled!
    const banners = dom.findAll((el) => el.classList?.contains('persistence-alert-banner'));
    assert.ok(
      banners.some((b) => b.textContent.toLowerCase().includes('internet') || b.textContent.toLowerCase().includes('offline')),
      'Offline provider rejection banner should appear'
    );
    assert.ok(getSaveBtn(), 'Inline editor must remain open with draft after offline rejection');
    assert.equal(getSaveBtn().disabled, false, 'Save & Resend must NOT remain permanently locked');
    assert.equal(getTextarea().disabled, false);
    assert.equal(fetchUrls.length, 0);

    // 2. Reconnect online WITHOUT cancelling or reopening the inline editor, and retry Save & Resend!
    await act(async () => {
      dom.setOnline(true);
    });
    assert.equal(getSaveBtn().disabled, false);

    await act(async () => {
      getSaveBtn().click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    assert.equal(getSaveBtn(), undefined, 'Inline editor should close once edit submission succeeds on reconnect');
    assert.ok(
      fetchUrls.some((u) => u.includes('/api/chat')),
      'Retrying Save & Resend after reconnecting should send request cleanly without cancelling/reopening'
    );

    // 3. Also test switching to Browser AI while STILL offline after offline-provider rejection
    await act(async () => {
      dom.setOnline(false);
    });
    const editTrigger2 = dom.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Edit message'
    )[0];
    assert.ok(editTrigger2, 'Edit message button should be rendered for second check');
    await act(async () => {
      editTrigger2.click();
    });
    assert.ok(getSaveBtn());

    // Offline rejection on Gemini leaves editor unlocked
    await act(async () => {
      getSaveBtn().click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.equal(getSaveBtn().disabled, false);

    // Click "Switch to Browser AI" in the offline banner without cancelling the editor
    const switchToBrowserBtn = dom.findAll(
      (el) => el.tagName === 'BUTTON' && el.classList?.contains('offline-switch-btn')
    )[0];
    assert.ok(switchToBrowserBtn, 'Switch to Browser AI button should be present');
    await act(async () => {
      switchToBrowserBtn.click();
    });
    assert.ok(getSaveBtn(), 'Editor remains open with Save & Resend enabled after switching to Browser AI');
    assert.equal(getSaveBtn().disabled, false);

    // Retrying Save & Resend now executes with Browser AI (past the offline cloud guard) and closes editor
    await act(async () => {
      getSaveBtn().click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    assert.equal(getSaveBtn(), undefined, 'Inline editor should close and proceed when retried with Browser AI');
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});
