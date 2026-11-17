import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import ChatArea from '../src/components/chat/ChatArea.jsx';
import { isComposerElementUnavailable } from '../src/components/chat/chatAreaUtils.js';
import Layout from '../src/components/layout/Layout.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { SettingsProvider } from '../src/context/SettingsContext.jsx';
import { SpeechProvider } from '../src/context/SpeechContext.jsx';

let cachedCreateRoot: ((container: any) => Root) | null = null;
async function getCreateRoot() {
  if (!cachedCreateRoot) {
    const mod = await import('react-dom/client');
    cachedCreateRoot = mod.createRoot;
  }
  return cachedCreateRoot;
}

function createMemoryStorage() {
  const store = new Map<string, string>();
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
    }
  };
}

function installComposerDom(options?: { innerWidth?: number }) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevSessionStorage = (globalThis as any).sessionStorage;
  const prevNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevHTMLInputElement = (globalThis as any).HTMLInputElement;
  const prevHTMLTextAreaElement = (globalThis as any).HTMLTextAreaElement;
  const prevResizeObserver = (globalThis as any).ResizeObserver;
  const prevIntersectionObserver = (globalThis as any).IntersectionObserver;
  const prevMatchMedia = (globalThis as any).matchMedia;
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
      if (entry.fn === fn && entry.capture === capture) {
        map.delete(entry);
      }
    }
  };

  let selectorMatchOverride: ((selector: string) => any) | null = null;

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
    readOnly = false;
    type = '';
    id = '';
    tabIndex = 0;
    scrollHeight = 72;
    scrollTop = 0;
    clientHeight = 100;
    selectionStart = 0;
    selectionEnd = 0;
    lastSelectionRange: [number, number] | null = null;

    constructor(tag: string, doc: any) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
    }

    get nodeName() {
      return this.tagName;
    }

    get isConnected() {
      let cur: any = this;
      while (cur) {
        if (cur === this.ownerDocument.body || cur === this.ownerDocument.documentElement) {
          return true;
        }
        cur = cur.parentNode;
      }
      return false;
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
      else if (k === 'readonly') this.readOnly = true;
      else if (k === 'value') this._value = sv;
    }

    getAttribute(k: string) {
      if (k === 'class') return this.className || null;
      if (k === 'id') return this.id || null;
      if (k === 'disabled') return this.disabled ? '' : null;
      if (k === 'readonly') return this.readOnly ? '' : null;
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
      else if (k === 'readonly') this.readOnly = false;
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

    focus() {
      if (this.disabled) return;
      doc.activeElement = this;
    }

    click() {
      if (this.disabled) return;
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

    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.lastSelectionRange = [start, end];
    }

    scrollIntoView() {}
    closest() {
      return null;
    }

    contains(node: any): boolean {
      if (node === this) return true;
      return this.childNodes.some((c) => (typeof c.contains === 'function' ? c.contains(node) : c === node));
    }

    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector: string) {
      const results: any[] = [];
      const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
      const matchesOne = (el: any, sel: string): boolean => {
        if (sel.startsWith('.')) {
          return el.classList.contains(sel.slice(1));
        }
        const roleMatch = sel.match(/^\[role="([^"]+)"\]$/);
        if (roleMatch) {
          return el.getAttribute('role') === roleMatch[1];
        }
        return el.tagName?.toLowerCase() === sel.toLowerCase();
      };
      const walk = (node: any) => {
        for (const child of node.childNodes || []) {
          if (child.nodeType === 1) {
            if (selectors.some((sel) => matchesOne(child, sel))) {
              results.push(child);
            }
            walk(child);
          }
        }
      };
      walk(this);
      return results;
    }
  }

  class FakeHTMLInputElement extends FakeElement {}
  class FakeHTMLTextAreaElement extends FakeElement {}

  const fakeNavigator: any = {
    onLine: true,
    userAgent: 'NodeTest/1.0'
  };

  const view: any = {
    innerWidth: options?.innerWidth ?? 1280,
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
      if (!ev.target) ev.target = this;
      ev.currentTarget = this;
      const set = listenerStore.get(this)?.get(ev.type);
      if (set) {
        for (const entry of Array.from(set)) {
          entry.fn.call(this, ev);
        }
      }
      return !ev.defaultPrevented;
    }
  };

  const doc: any = {
    nodeType: 9,
    compatMode: 'CSS1Compat',
    oninput: null,
    documentElement: null as any,
    body: null as any,
    defaultView: view,
    activeElement: null as any,
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
    querySelector(selector: string) {
      if (selectorMatchOverride) {
        const overridden = selectorMatchOverride(selector);
        if (overridden) return overridden;
      }
      return this.body.querySelector(selector);
    },
    querySelectorAll(selector: string) {
      return this.body.querySelectorAll(selector);
    }
  };

  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  view.document = doc;

  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();
  view.localStorage = localStorage;
  view.sessionStorage = sessionStorage;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = view;
  (globalThis as any).document = doc;
  (globalThis as any).localStorage = localStorage;
  (globalThis as any).sessionStorage = sessionStorage;
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLInputElement = FakeHTMLInputElement;
  (globalThis as any).HTMLTextAreaElement = FakeHTMLTextAreaElement;
  (globalThis as any).matchMedia = view.matchMedia;
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
  const rafTimers = new Set<any>();
  (globalThis as any).requestAnimationFrame = (cb: Function) => {
    const id = setTimeout(() => {
      rafTimers.delete(id);
      cb(Date.now());
    }, 0);
    rafTimers.add(id);
    return id;
  };
  (globalThis as any).cancelAnimationFrame = (id: any) => {
    rafTimers.delete(id);
    clearTimeout(id);
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: fakeNavigator
  });

  function createKeyEvent(
    key: string,
    opts?: {
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
      isComposing?: boolean;
      keyCode?: number;
      defaultPrevented?: boolean;
    }
  ) {
    return {
      type: 'keydown',
      key,
      ctrlKey: Boolean(opts?.ctrlKey),
      metaKey: Boolean(opts?.metaKey),
      altKey: Boolean(opts?.altKey),
      shiftKey: Boolean(opts?.shiftKey),
      isComposing: Boolean(opts?.isComposing),
      keyCode: opts?.keyCode ?? 0,
      bubbles: true,
      cancelable: true,
      defaultPrevented: Boolean(opts?.defaultPrevented),
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      }
    };
  }

  return {
    window: view,
    document: doc,
    createKeyEvent,
    setSelectorOverride(fn: ((selector: string) => any) | null) {
      selectorMatchOverride = fn;
    },
    query(selector: string) {
      return doc.body.querySelector(selector);
    },
    queryAll(selector: string) {
      return doc.body.querySelectorAll(selector);
    },
    cleanup() {
      for (const id of rafTimers) {
        clearTimeout(id);
      }
      rafTimers.clear();
      (globalThis as any).window = prevWindow;
      (globalThis as any).document = prevDocument;
      (globalThis as any).localStorage = prevLocalStorage;
      (globalThis as any).sessionStorage = prevSessionStorage;
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      (globalThis as any).HTMLElement = prevHTMLElement;
      (globalThis as any).HTMLInputElement = prevHTMLInputElement;
      (globalThis as any).HTMLTextAreaElement = prevHTMLTextAreaElement;
      (globalThis as any).ResizeObserver = prevResizeObserver;
      (globalThis as any).IntersectionObserver = prevIntersectionObserver;
      (globalThis as any).matchMedia = prevMatchMedia;
      (globalThis as any).requestAnimationFrame = prevRAF;
      (globalThis as any).cancelAnimationFrame = prevCAF;
      if (prevNavigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', prevNavigatorDescriptor);
      } else {
        delete (globalThis as any).navigator;
      }
    }
  };
}

function createHarness(initialProps: Record<string, any> = {}) {
  const inputCalls: string[] = [];
  const submitCalls: Array<{ attachments: any[]; overrideText: string | null }> = [];
  const stopCalls: number[] = [];

  let updateExternalProps: ((patch: Record<string, any>) => void) | null = null;
  let currentPropsState: Record<string, any> = { ...initialProps };

  function Harness() {
    const [propsState, setPropsState] = useState<Record<string, any>>(initialProps);
    const [inputVal, setInputVal] = useState<string>(initialProps.initialInputValue ?? '');

    updateExternalProps = (patch: Record<string, any>) => {
      currentPropsState = { ...currentPropsState, ...patch };
      if ('inputValue' in patch) {
        setInputVal(patch.inputValue);
      }
      setPropsState((prev) => ({ ...prev, ...patch }));
    };

    const effectiveInputValue = propsState.controlledInputValue ?? inputVal;

    return React.createElement(
      AuthProvider,
      null,
      React.createElement(
        SettingsProvider,
        null,
        React.createElement(
          SpeechProvider,
          null,
          React.createElement(
            ChatArea as any,
            {
              activeChatId: 'chat-1',
              messages: [
                { id: 'u1', role: 'user', content: 'Hello', timestamp: Date.now() },
                { id: 'a1', role: 'assistant', content: 'Working...', timestamp: Date.now(), isStreaming: Boolean(propsState.isLoading) }
              ],
          isLoading: false,
          isNewChat: false,
          inputValue: effectiveInputValue,
          onInputChange: (nextVal: string) => {
            inputCalls.push(nextVal);
            setInputVal(nextVal);
          },
          onSubmit: async (attachments: any[], overrideText: string | null) => {
            submitCalls.push({ attachments, overrideText });
            return true;
          },
          onStopGenerating: () => {
            stopCalls.push(Date.now());
          },
          ...propsState
        })
        )
      )
    );
  }

  return {
    Harness,
    inputCalls,
    submitCalls,
    stopCalls,
    updateProps(patch: Record<string, any>) {
      if (updateExternalProps) {
        updateExternalProps(patch);
      }
    }
  };
}

test('ORVIX-LOW-06: isComposerElementUnavailable detects disabled, readOnly, aria-disabled, and disconnected elements', () => {
  assert.equal(isComposerElementUnavailable(null), true);
  assert.equal(isComposerElementUnavailable(undefined), true);
  assert.equal(isComposerElementUnavailable({ disabled: true, readOnly: false, isConnected: true }), true);
  assert.equal(isComposerElementUnavailable({ disabled: false, readOnly: true, isConnected: true }), true);
  assert.equal(isComposerElementUnavailable({ disabled: false, readOnly: false, isConnected: false }), true);
  assert.equal(
    isComposerElementUnavailable({
      disabled: false,
      readOnly: false,
      isConnected: true,
      hasAttribute: (k: string) => k === 'readonly'
    }),
    true
  );
  assert.equal(
    isComposerElementUnavailable({
      disabled: false,
      readOnly: false,
      isConnected: true,
      getAttribute: (k: string) => (k === 'aria-disabled' ? 'true' : null)
    }),
    true
  );
  assert.equal(
    isComposerElementUnavailable({
      disabled: false,
      readOnly: false,
      isConnected: true,
      hasAttribute: () => false,
      getAttribute: () => null
    }),
    false
  );
});

test('ORVIX-LOW-06: global keyboard shortcuts cannot insert text while composer is disabled (read-only / public viewer / submitting shared preview)', async () => {
  const dom = installComposerDom();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  let root: Root | null = null;

  try {
    const createRoot = await getCreateRoot();
    const harness = createHarness({ isReadOnly: true, isPublicSharedViewer: true });
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(harness.Harness));
    });

    const textarea = dom.query('.composer-textarea');
    assert.ok(textarea, 'Composer textarea rendered');
    assert.equal(textarea.disabled, true);
    assert.equal(textarea.value, '');

    const keyEvent = dom.createKeyEvent('a');
    await act(async () => {
      dom.window.dispatchEvent(keyEvent);
    });

    assert.equal(keyEvent.defaultPrevented, false, 'Disabled composer must not hijack or preventDefault printable key');
    assert.equal(harness.inputCalls.length, 0, 'onInputChange must not be called when read-only');
    assert.equal(textarea.value, '', 'Textarea value must remain empty');
    assert.notEqual(dom.document.activeElement, textarea, 'Disabled textarea must not be focused');

    // Switch to authenticated shared preview during first-message submission
    await act(async () => {
      harness.updateProps({
        isReadOnly: true,
        isPublicSharedViewer: false,
        isAuthenticatedSharedPreview: true,
        isSubmittingFirstSharedMessage: true
      });
    });

    assert.equal(dom.query('.composer-textarea').disabled, true, 'Composer textarea disabled while submitting first shared message');
    const sharedEvent = dom.createKeyEvent('b');
    await act(async () => {
      dom.window.dispatchEvent(sharedEvent);
    });
    assert.equal(sharedEvent.defaultPrevented, false);
    assert.equal(harness.inputCalls.length, 0);
    assert.equal(dom.query('.composer-textarea').value, '');
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    dom.cleanup();
  }
});

test('ORVIX-LOW-06: global shortcuts cannot modify composer during active AI generation (isLoading)', async () => {
  const dom = installComposerDom();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  let root: Root | null = null;

  try {
    const createRoot = await getCreateRoot();
    const harness = createHarness({
      initialInputValue: 'Existing draft',
      isLoading: true
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(harness.Harness));
    });

    const textarea = dom.query('.composer-textarea');
    assert.ok(textarea);
    assert.equal(textarea.disabled, true);
    assert.equal(textarea.value, 'Existing draft');
    dom.document.activeElement = dom.document.body;

    for (const ch of ['x', 'y', '1', '!']) {
      const ev = dom.createKeyEvent(ch);
      await act(async () => {
        dom.window.dispatchEvent(ev);
      });
      assert.equal(ev.defaultPrevented, false, `Key '${ch}' must not be hijacked during generation`);
    }

    assert.equal(harness.inputCalls.length, 0, 'No draft mutations allowed while isLoading is true');
    assert.equal(textarea.value, 'Existing draft');
    assert.equal(textarea.lastSelectionRange, null);
    assert.notEqual(dom.document.activeElement, textarea);

    // Programmatic Enter / Ctrl+Enter directly on disabled textarea cannot submit or clear state
    const enterEv = dom.createKeyEvent('Enter');
    await act(async () => {
      textarea.dispatchEvent(enterEv);
    });
    const ctrlEnterEv = dom.createKeyEvent('Enter', { ctrlKey: true });
    await act(async () => {
      textarea.dispatchEvent(ctrlEnterEv);
    });

    assert.equal(enterEv.defaultPrevented, false);
    assert.equal(ctrlEnterEv.defaultPrevented, false);
    assert.equal(harness.submitCalls.length, 0, 'Programmatic Enter on disabled composer must not submit');
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    dom.cleanup();
  }
});

test('ORVIX-LOW-06: unrelated keyboard shortcuts continue working while composer is disabled during generation', async () => {
  const dom = installComposerDom({ innerWidth: 390 });
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  let root: Root | null = null;

  try {
    const createRoot = await getCreateRoot();
    const harness = createHarness({ isLoading: true });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            SettingsProvider,
            null,
            React.createElement(
              SpeechProvider,
              null,
              React.createElement(
                Layout as any,
                {
                  onNewChat: () => {}
                },
                React.createElement(harness.Harness)
              )
            )
          )
        )
      );
    });

    const textarea = dom.query('.composer-textarea');
    assert.ok(textarea);
    assert.equal(textarea.disabled, true);

    // Non-mutating modifier shortcut passes through untouched
    const ctrlK = dom.createKeyEvent('k', { ctrlKey: true });
    await act(async () => {
      dom.window.dispatchEvent(ctrlK);
    });
    assert.equal(ctrlK.defaultPrevented, false);
    assert.equal(harness.inputCalls.length, 0);

    // Open mobile sidebar and verify unrelated Layout Escape closes it while composer is generating
    const menuBtn = dom.query('.mobile-menu-btn');
    assert.ok(menuBtn, 'Mobile menu button rendered');
    await act(async () => {
      menuBtn.click();
    });
    assert.equal(
      dom.query('.orvix-sidebar')?.classList.contains('collapsed'),
      false,
      'Mobile sidebar opens before Escape shortcut'
    );

    const layoutEsc = dom.createKeyEvent('Escape');
    await act(async () => {
      dom.window.dispatchEvent(layoutEsc);
    });
    assert.equal(
      dom.query('.orvix-sidebar')?.classList.contains('collapsed'),
      true,
      'Layout mobile Escape shortcut must continue working while composer is disabled'
    );

    // Escape on composer still triggers onStopGenerating during active loading
    const stopEsc = dom.createKeyEvent('Escape');
    await act(async () => {
      textarea.dispatchEvent(stopEsc);
    });
    assert.equal(stopEsc.defaultPrevented, true);
    assert.equal(harness.stopCalls.length, 1, 'Escape to stop generation must still work');
    assert.equal(harness.inputCalls.length, 0);
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    dom.cleanup();
  }
});

test('ORVIX-LOW-06: composer shortcuts resume working normally after generation finishes', async () => {
  const dom = installComposerDom();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  let root: Root | null = null;

  try {
    const createRoot = await getCreateRoot();
    const harness = createHarness({
      initialInputValue: 'Hello',
      isLoading: true
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(harness.Harness));
    });

    const textarea = dom.query('.composer-textarea');
    textarea.selectionStart = 5;
    textarea.selectionEnd = 5;
    dom.document.activeElement = dom.document.body;

    // Blocked while loading
    await act(async () => {
      dom.window.dispatchEvent(dom.createKeyEvent('!'));
    });
    assert.equal(harness.inputCalls.length, 0);
    assert.equal(textarea.value, 'Hello');

    // Generation completes
    await act(async () => {
      harness.updateProps({ isLoading: false });
    });

    assert.equal(textarea.disabled, false);

    // Type-to-focus shortcut works normally again
    const globalKey = dom.createKeyEvent('!');
    await act(async () => {
      dom.window.dispatchEvent(globalKey);
    });

    assert.equal(globalKey.defaultPrevented, true);
    assert.deepEqual(harness.inputCalls, ['Hello!']);
    assert.equal(textarea.value, 'Hello!');
    assert.equal(dom.document.activeElement, textarea);
    assert.deepEqual(textarea.lastSelectionRange, [6, 6]);

    // Normal Enter submission works after generation finishes
    const enterEv = dom.createKeyEvent('Enter');
    await act(async () => {
      textarea.dispatchEvent(enterEv);
    });
    assert.equal(enterEv.defaultPrevented, true);
    assert.equal(harness.submitCalls.length, 1);
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    dom.cleanup();
  }
});

test('ORVIX-LOW-06: focus changes and rapid disabled/enabled generation transitions avoid stale-state mutations', async () => {
  const dom = installComposerDom();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  let root: Root | null = null;

  try {
    const createRoot = await getCreateRoot();
    const harness = createHarness({
      initialInputValue: 'Draft',
      isLoading: false
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(harness.Harness));
    });

    const textarea = dom.query('.composer-textarea');
    textarea.selectionStart = 5;
    textarea.selectionEnd = 5;

    // Rapid transition: enabled -> loading -> enabled -> loading
    await act(async () => {
      harness.updateProps({ isLoading: true });
    });
    dom.document.activeElement = dom.query('.composer-stop-btn') || dom.document.body;
    await act(async () => {
      dom.window.dispatchEvent(dom.createKeyEvent('a'));
    });
    assert.equal(harness.inputCalls.length, 0, 'Blocked on first loading transition');

    await act(async () => {
      harness.updateProps({ isLoading: false });
    });
    // Move focus to body and verify typing succeeds
    dom.document.activeElement = dom.document.body;
    await act(async () => {
      dom.window.dispatchEvent(dom.createKeyEvent('b'));
    });
    assert.deepEqual(harness.inputCalls, ['Draftb']);
    assert.equal(dom.document.activeElement, textarea);

    // Move focus to a separate unrelated input while composer is enabled: must not hijack
    const otherInput = dom.document.createElement('input');
    dom.document.body.appendChild(otherInput);
    dom.document.activeElement = otherInput;
    const otherInputEvent = dom.createKeyEvent('c');
    await act(async () => {
      dom.window.dispatchEvent(otherInputEvent);
    });
    assert.equal(otherInputEvent.defaultPrevented, false);
    assert.deepEqual(harness.inputCalls, ['Draftb']);

    // Rapid flip back to loading while focus returns to body
    dom.document.activeElement = dom.document.body;
    await act(async () => {
      harness.updateProps({ isLoading: true });
    });
    await act(async () => {
      dom.window.dispatchEvent(dom.createKeyEvent('d'));
    });
    assert.deepEqual(harness.inputCalls, ['Draftb'], 'Blocked immediately on rapid re-disable');
    assert.equal(textarea.value, 'Draftb');
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    dom.cleanup();
  }
});

test('ORVIX-LOW-06: directly disabled or read-only composer DOM elements cannot be bypassed by programmatic shortcut or change events', async () => {
  const dom = installComposerDom();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  let root: Root | null = null;

  try {
    const createRoot = await getCreateRoot();
    const harness = createHarness({
      initialInputValue: 'Locked',
      isLoading: false
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(harness.Harness));
    });

    const textarea = dom.query('.composer-textarea');
    assert.equal(textarea.disabled, false);

    // 1. Mark textarea readOnly directly in DOM without flipping React props
    textarea.setAttribute('readonly', '');
    dom.document.activeElement = dom.document.body;

    const roGlobalKey = dom.createKeyEvent('z');
    await act(async () => {
      dom.window.dispatchEvent(roGlobalKey);
    });
    assert.equal(roGlobalKey.defaultPrevented, false);
    assert.equal(harness.inputCalls.length, 0);
    assert.equal(textarea.value, 'Locked');

    const roEnter = dom.createKeyEvent('Enter');
    await act(async () => {
      textarea.dispatchEvent(roEnter);
    });
    assert.equal(roEnter.defaultPrevented, false);
    assert.equal(harness.submitCalls.length, 0);

    textarea.removeAttribute('readonly');

    // 2. Mark aria-disabled="true" in DOM
    textarea.setAttribute('aria-disabled', 'true');
    const ariaKey = dom.createKeyEvent('q');
    await act(async () => {
      dom.window.dispatchEvent(ariaKey);
    });
    assert.equal(ariaKey.defaultPrevented, false);
    assert.equal(harness.inputCalls.length, 0);
    assert.equal(textarea.value, 'Locked');
    textarea.removeAttribute('aria-disabled');

    // 3. Mark disabled directly in DOM and dispatch programmatic input/change event
    textarea.disabled = true;
    const progKey = dom.createKeyEvent('p');
    await act(async () => {
      dom.window.dispatchEvent(progKey);
    });
    assert.equal(progKey.defaultPrevented, false);
    assert.equal(harness.inputCalls.length, 0);

    await act(async () => {
      textarea.value = 'Bypassed';
      textarea.dispatchEvent({
        type: 'change',
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
    });
    assert.equal(harness.inputCalls.length, 0, 'Programmatic change on disabled textarea must not call onInputChange');
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    dom.cleanup();
  }
});
