import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import ChatArea from '../src/components/chat/ChatArea.jsx';
import TranscriptPolishReview from '../src/components/chat/TranscriptPolishReview.jsx';
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

function installComposerControlDom() {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevSessionStorage = (globalThis as any).sessionStorage;
  const prevNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevHTMLInputElement = (globalThis as any).HTMLInputElement;
  const prevHTMLTextAreaElement = (globalThis as any).HTMLTextAreaElement;
  const prevHTMLIFrameElement = (globalThis as any).HTMLIFrameElement;
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
      return this.childNodes.map((c: any) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
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
      const idx = this.childNodes.indexOf(c);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      const refIdx = ref ? this.childNodes.indexOf(ref) : -1;
      if (refIdx === -1) this.childNodes.push(c);
      else this.childNodes.splice(refIdx, 0, c);
      c.parentNode = this;
      return c;
    }

    hasChildNodes() {
      return this.childNodes.length > 0;
    }

    setAttribute(name: string, val: string) {
      const s = String(val);
      this.attributes.set(name, s);
      if (name === 'class') this.className = s;
      else if (name === 'id') this.id = s;
      else if (name === 'disabled') this.disabled = true;
      else if (name === 'readonly') this.readOnly = true;
      else if (name === 'value') this._value = s;
    }

    getAttribute(name: string) {
      if (name === 'class') return this.className || null;
      if (name === 'id') return this.id || null;
      if (name === 'disabled') return this.disabled ? '' : null;
      if (name === 'readonly') return this.readOnly ? '' : null;
      return this.attributes.has(name) ? this.attributes.get(name)! : null;
    }

    removeAttribute(name: string) {
      this.attributes.delete(name);
      if (name === 'class') this.className = '';
      else if (name === 'disabled') this.disabled = false;
      else if (name === 'readonly') this.readOnly = false;
    }

    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(this, type, fn, opts);
    }

    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(this, type, fn, opts);
    }

    dispatchEvent(event: any) {
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
    }

    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }

    contains(other: any) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    scrollTo() {}
    scrollIntoView() {}
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
    }
  }

  class FakeHTMLInputElement extends FakeElement {}
  class FakeHTMLTextAreaElement extends FakeElement {}

  const invokeListeners = (node: any, event: any, capturePhase: boolean) => {
    const set = listenerStore.get(node)?.get(event.type);
    if (!set) return;
    event.currentTarget = node;
    for (const entry of Array.from(set)) {
      if (entry.capture === capturePhase) {
        entry.fn.call(node, event);
      }
    }
  };

  const dispatchDomEvent = (target: any, event: any) => {
    const path: any[] = [];
    let cur = target;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode || (cur === doc ? view : cur === doc.documentElement ? doc : null);
    }
    for (let i = path.length - 1; i >= 0; i--) {
      if (event.propagationStopped) break;
      invokeListeners(path[i], event, true);
    }
    for (let i = 0; i < path.length; i++) {
      if (event.propagationStopped) break;
      if (i > 0 && !event.bubbles) break;
      invokeListeners(path[i], event, false);
    }
    return !event.defaultPrevented;
  };

  const createFakeEvent = (type: string, target: any, extra: Record<string, any> = {}) => {
    const ev: any = {
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
    return ev;
  };

  const lStorage = createMemoryStorage();
  const sStorage = createMemoryStorage();

  // Mock SpeechRecognition so pre-recording dictation language controls render
  class FakeSpeechRecognition {
    lang = 'en-US';
    continuous = true;
    interimResults = true;
    start() {}
    stop() {}
    abort() {}
  }

  const view: any = {
    HTMLIFrameElement: class {},
    HTMLElement: FakeElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    SpeechRecognition: FakeSpeechRecognition,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: lStorage,
    sessionStorage: sStorage,
    location: { pathname: '/', origin: 'http://localhost:3000', search: '', hash: '' },
    navigator: {
      onLine: true,
      userAgent: 'Mozilla/5.0 Chrome/120.0.0.0',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) }
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    }),
    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(view, type, fn, opts);
    },
    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(view, type, fn, opts);
    },
    dispatchEvent(ev: any) {
      return dispatchDomEvent(view, ev);
    }
  };

  const doc: any = {
    nodeType: 9,
    documentElement: null as any,
    body: null as any,
    defaultView: view,
    activeElement: null,
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
    dispatchEvent(ev: any) {
      return dispatchDomEvent(doc, ev);
    },
    querySelector() {
      return null;
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
  (globalThis as any).localStorage = lStorage;
  (globalThis as any).sessionStorage = sStorage;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: view.navigator
  });
  (globalThis as any).HTMLIFrameElement = view.HTMLIFrameElement;
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
  (globalThis as any).matchMedia = view.matchMedia;
  (globalThis as any).requestAnimationFrame = (cb: Function) => {
    cb(Date.now());
    return 1;
  };
  (globalThis as any).cancelAnimationFrame = () => {};

  const walk = (node: any, pred: (n: any) => boolean, out: any[] = []): any[] => {
    if (!node || !Array.isArray(node.childNodes)) return out;
    for (const child of node.childNodes) {
      if (pred(child)) out.push(child);
      walk(child, pred, out);
    }
    return out;
  };

  return {
    window: view,
    document: doc,
    container,
    createFakeEvent,
    queryByClass: (cls: string) =>
      walk(container, (n) => n.nodeType === 1 && n.classList?.contains(cls))[0] || null,
    queryAllByClass: (cls: string) =>
      walk(container, (n) => n.nodeType === 1 && n.classList?.contains(cls)),
    queryByTag: (tag: string) =>
      walk(container, (n) => n.nodeType === 1 && n.tagName === tag.toUpperCase())[0] || null,
    queryAllButtons: () =>
      walk(container, (n) => n.nodeType === 1 && n.tagName === 'BUTTON'),
    restore() {
      if (prevActEnv === undefined) delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
      else (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
      if (prevDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDocument;
      if (prevLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = prevLocalStorage;
      if (prevSessionStorage === undefined) delete (globalThis as any).sessionStorage;
      else (globalThis as any).sessionStorage = prevSessionStorage;
      if (prevNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', prevNavigatorDescriptor);
      if (prevHTMLElement === undefined) delete (globalThis as any).HTMLElement;
      else (globalThis as any).HTMLElement = prevHTMLElement;
      if (prevHTMLIFrameElement === undefined) delete (globalThis as any).HTMLIFrameElement;
      else (globalThis as any).HTMLIFrameElement = prevHTMLIFrameElement;
      if (prevHTMLInputElement === undefined) delete (globalThis as any).HTMLInputElement;
      else (globalThis as any).HTMLInputElement = prevHTMLInputElement;
      if (prevHTMLTextAreaElement === undefined) delete (globalThis as any).HTMLTextAreaElement;
      else (globalThis as any).HTMLTextAreaElement = prevHTMLTextAreaElement;
      if (prevResizeObserver === undefined) delete (globalThis as any).ResizeObserver;
      else (globalThis as any).ResizeObserver = prevResizeObserver;
      if (prevIntersectionObserver === undefined) delete (globalThis as any).IntersectionObserver;
      else (globalThis as any).IntersectionObserver = prevIntersectionObserver;
      if (prevMatchMedia === undefined) delete (globalThis as any).matchMedia;
      else (globalThis as any).matchMedia = prevMatchMedia;
      if (prevRAF === undefined) delete (globalThis as any).requestAnimationFrame;
      else (globalThis as any).requestAnimationFrame = prevRAF;
      if (prevCAF === undefined) delete (globalThis as any).cancelAnimationFrame;
      else (globalThis as any).cancelAnimationFrame = prevCAF;
    }
  };
}

function wrapWithProviders(children: React.ReactNode) {
  return React.createElement(
    AuthProvider as any,
    null,
    React.createElement(
      SettingsProvider as any,
      null,
      React.createElement(SpeechProvider as any, null, children)
    )
  );
}

test('ORVIX-LOW-10: drag-and-drop and pre-recording dictation language controls stay disabled/blocked during generation and recover afterwards', async () => {
  const dom = installComposerControlDom();
  const createRoot = await getCreateRoot();
  const root = createRoot(dom.container as unknown as Element);

  let setLoadingExternal: ((val: boolean) => void) | null = null;

  function Harness() {
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    setLoadingExternal = setIsLoading;

    return wrapWithProviders(
      React.createElement(ChatArea as any, {
        activeChatId: 'chat-low10-1',
        messages: [],
        isLoading,
        isNewChat: true,
        inputValue,
        onInputChange: setInputValue,
        onSubmit: async () => true,
        onStopGenerating: () => {}
      })
    );
  }

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    const mainEl = dom.queryByClass('chat-area-container');
    const langBtnBefore = dom.queryByClass('composer-lang-btn');
    const attachBtnBefore = dom.queryByClass('composer-attach-btn');
    const micBtnBefore = dom.queryByClass('composer-mic-btn');
    assert.ok(mainEl);
    assert.ok(langBtnBefore);
    assert.equal(langBtnBefore.disabled, false);
    assert.equal(attachBtnBefore.disabled, false);
    assert.equal(micBtnBefore.disabled, false);

    // 1. Open pre-recording language dropdown while enabled, then transition into generation (isLoading = true)
    await act(async () => {
      langBtnBefore.click();
    });
    assert.ok(dom.queryByClass('dictation-lang-dropdown'), 'Language menu should open when enabled');

    await act(async () => {
      setLoadingExternal!(true);
    });

    assert.equal(dom.queryByClass('dictation-lang-dropdown'), null, 'Open language menu must close when generation starts');
    assert.equal(dom.queryByClass('composer-lang-btn').disabled, true, 'Language button must be disabled during generation');
    assert.equal(dom.queryByClass('composer-lang-btn').getAttribute('aria-disabled'), 'true');
    assert.equal(dom.queryByClass('composer-attach-btn').disabled, true);
    assert.equal(dom.queryByClass('composer-mic-btn').disabled, true);

    // Attempt clicking language button during generation -> dropdown stays closed
    await act(async () => {
      dom.queryByClass('composer-lang-btn').click();
    });
    assert.equal(dom.queryByClass('dictation-lang-dropdown'), null);

    // 2. Drag-and-drop during generation must NOT show drop banner or attach files
    const sampleFile = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    const dt = {
      types: ['Files'],
      files: [sampleFile],
      items: [{ kind: 'file', getAsFile: () => sampleFile }],
      dropEffect: 'none'
    };

    await act(async () => {
      mainEl.dispatchEvent(dom.createFakeEvent('dragenter', mainEl, { dataTransfer: dt }));
      mainEl.dispatchEvent(dom.createFakeEvent('dragover', mainEl, { dataTransfer: dt }));
    });
    assert.equal(dom.queryByClass('composer-drop-banner'), null, 'Drop banner must NOT open during generation');
    assert.equal(mainEl.classList.contains('is-drag-over'), false);

    await act(async () => {
      mainEl.dispatchEvent(dom.createFakeEvent('drop', mainEl, { dataTransfer: dt }));
    });
    assert.equal(dom.queryByClass('composer-attachments-preview'), null, 'File drop must NOT attach during generation');

    // 3. Finish generation -> controls re-enable and drag-drop / language dropdown work again
    await act(async () => {
      setLoadingExternal!(false);
    });

    assert.equal(dom.queryByClass('composer-lang-btn').disabled, false);
    assert.equal(dom.queryByClass('composer-attach-btn').disabled, false);
    assert.equal(dom.queryByClass('composer-mic-btn').disabled, false);

    // Active drag starts, then generation starts mid-drag -> drag banner clears cleanly
    await act(async () => {
      mainEl.dispatchEvent(dom.createFakeEvent('dragenter', mainEl, { dataTransfer: dt }));
    });
    assert.ok(dom.queryByClass('composer-drop-banner'), 'Drop banner opens normally when idle');

    await act(async () => {
      setLoadingExternal!(true);
    });
    assert.equal(dom.queryByClass('composer-drop-banner'), null, 'Active drag banner must reset if generation starts mid-drag');
    assert.equal(mainEl.classList.contains('is-drag-over'), false);

    // Return to idle and verify drop attaches cleanly & language picker opens cleanly
    await act(async () => {
      setLoadingExternal!(false);
    });
    await act(async () => {
      mainEl.dispatchEvent(dom.createFakeEvent('drop', mainEl, { dataTransfer: dt }));
    });
    assert.ok(dom.queryByClass('composer-attachments-preview'), 'File drop attaches normally after generation completes');

    await act(async () => {
      dom.queryByClass('composer-lang-btn').click();
    });
    assert.ok(dom.queryByClass('dictation-lang-dropdown'), 'Language menu opens normally after generation completes');
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test('ORVIX-LOW-10: TranscriptPolishReview disables Polish text and Apply Polish when blocked while keeping dismiss controls usable', async () => {
  const dom = installComposerControlDom();
  const createRoot = await getCreateRoot();
  const root = createRoot(dom.container as unknown as Element);

  let polishCalls = 0;
  let applyCalls = 0;
  let dismissTranscriptCalls = 0;
  let dismissReviewCalls = 0;

  try {
    // 1. Banner stage while blocked: "Polish text" disabled, Dismiss enabled
    await act(async () => {
      root.render(
        React.createElement(TranscriptPolishReview, {
          lastSessionTranscript: 'write a palindrome checker',
          suggestedRefinement: null,
          isCleaningTranscript: false,
          isComposerBlocked: true,
          onImproveTranscript: () => {
            polishCalls += 1;
          },
          onApplyRefinement: () => {
            applyCalls += 1;
          },
          onDismissReview: () => {
            dismissReviewCalls += 1;
          },
          onDismissTranscript: () => {
            dismissTranscriptCalls += 1;
          }
        })
      );
    });

    const polishBtnBlocked = dom.queryByClass('cleanup-action-trigger');
    const dismissBannerBtn = dom.queryByClass('cleanup-dismiss-btn');
    assert.ok(polishBtnBlocked);
    assert.ok(dismissBannerBtn);
    assert.equal(polishBtnBlocked.disabled, true, 'Polish text must be disabled when composer is blocked');
    assert.equal(dismissBannerBtn.disabled, false, 'Dismiss helper must stay usable when composer is blocked');

    await act(async () => {
      polishBtnBlocked.click();
      dismissBannerBtn.click();
    });
    assert.equal(polishCalls, 0, 'Clicking disabled Polish text must not invoke callback');
    assert.equal(dismissTranscriptCalls, 1, 'Dismiss helper remains clickable when blocked');

    // 2. Review stage while blocked: "Apply Polish" disabled, "Keep original" and close X enabled
    await act(async () => {
      root.render(
        React.createElement(TranscriptPolishReview, {
          lastSessionTranscript: 'write a palindrome checker',
          suggestedRefinement: 'Write a palindrome checker.',
          isCleaningTranscript: false,
          isComposerBlocked: true,
          onImproveTranscript: () => {
            polishCalls += 1;
          },
          onApplyRefinement: () => {
            applyCalls += 1;
          },
          onDismissReview: () => {
            dismissReviewCalls += 1;
          },
          onDismissTranscript: () => {}
        })
      );
    });

    const buttonsBlocked = dom.queryAllButtons();
    const applyBtnBlocked = buttonsBlocked.find((b) => b.textContent.includes('Apply Polish'));
    const keepBtnBlocked = buttonsBlocked.find((b) => b.textContent.includes('Keep original'));
    const closeReviewBtn = dom.queryByClass('review-close-btn');
    assert.ok(applyBtnBlocked);
    assert.ok(keepBtnBlocked);
    assert.ok(closeReviewBtn);
    assert.equal(applyBtnBlocked.disabled, true, 'Apply Polish must be disabled when composer is blocked');
    assert.equal(keepBtnBlocked.disabled, false, 'Keep original must remain usable');
    assert.equal(closeReviewBtn.disabled, false, 'Close review must remain usable');

    await act(async () => {
      applyBtnBlocked.click();
      keepBtnBlocked.click();
    });
    assert.equal(applyCalls, 0);
    assert.equal(dismissReviewCalls, 1);

    // 3. Unblocked stage: "Apply Polish" re-enables and applies cleanly
    await act(async () => {
      root.render(
        React.createElement(TranscriptPolishReview, {
          lastSessionTranscript: 'write a palindrome checker',
          suggestedRefinement: 'Write a palindrome checker.',
          isCleaningTranscript: false,
          isComposerBlocked: false,
          onImproveTranscript: () => {
            polishCalls += 1;
          },
          onApplyRefinement: () => {
            applyCalls += 1;
          },
          onDismissReview: () => {},
          onDismissTranscript: () => {}
        })
      );
    });

    const applyBtnEnabled = dom.queryAllButtons().find((b) => b.textContent.includes('Apply Polish'));
    assert.ok(applyBtnEnabled);
    assert.equal(applyBtnEnabled.disabled, false);
    await act(async () => {
      applyBtnEnabled.click();
    });
    assert.equal(applyCalls, 1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});

test('ORVIX-LOW-10: authenticated shared-preview controls and UI labels match isComposerDisabled instead of raw isReadOnly', async () => {
  const dom = installComposerControlDom();
  const createRoot = await getCreateRoot();
  const root = createRoot(dom.container as unknown as Element);

  let submittedPrompts: string[] = [];

  const truncatedSharedMessages = [
    { id: 'u1', sender: 'user', content: 'Write a detailed guide.', createdAtMs: 1700000001000 },
    {
      id: 'a1',
      sender: 'assistant',
      content: 'Part 1 of the guide...\n\n---\n**This is a large response, so I’ve provided the first part. Reply "Continue" and I’ll send the rest.**',
      createdAtMs: 1700000002000
    }
  ];

  try {
    // 1. Authenticated Shared Preview (isReadOnly = true, isSharedView = true, isAuthenticatedSharedPreview = true)
    await act(async () => {
      root.render(
        wrapWithProviders(
          React.createElement(ChatArea as any, {
            activeChatId: null,
            messages: truncatedSharedMessages,
            isLoading: false,
            isNewChat: false,
            inputValue: 'Follow-up question',
            onInputChange: () => {},
            onSubmit: async (_atts: any[], override?: string | null) => {
              submittedPrompts.push(override || 'Follow-up question');
              return true;
            },
            isReadOnly: true,
            isSharedView: true,
            isAuthenticatedSharedPreview: true,
            isPublicSharedViewer: false,
            isSubmittingFirstSharedMessage: false,
            sharedSnapshot: { id: 'SharedPreview001', title: 'Preview Thread', mode: 'general', messages: truncatedSharedMessages }
          })
        )
      );
    });

    const mainPreview = dom.queryByClass('chat-area-container');
    const textareaPreview = dom.queryByClass('composer-textarea');
    const sendBtnPreview = dom.queryByClass('composer-send-btn');
    const continueBtnPreview = dom.queryByClass('continuation-prompt-chip');
    const attachBtnPreview = dom.queryByClass('composer-attach-btn');
    const micBtnPreview = dom.queryByClass('composer-mic-btn');
    const langBtnPreview = dom.queryByClass('composer-lang-btn');

    assert.ok(mainPreview);
    assert.equal(mainPreview.classList.contains('is-read-only-view'), false, 'Authenticated shared preview must NOT receive is-read-only-view class');
    assert.equal(textareaPreview.disabled, false, 'Composer textarea must be enabled in authenticated shared preview');
    assert.equal(sendBtnPreview.disabled, false, 'Send button must be enabled when content exists');
    assert.equal(sendBtnPreview.classList.contains('is-ready'), true, 'Send button must get is-ready class (not stale is-empty from raw isReadOnly)');
    assert.equal(sendBtnPreview.getAttribute('aria-label'), 'Send message', 'Send button aria-label must reflect active messaging');

    assert.ok(continueBtnPreview, 'Continue response chip must be available in authenticated shared preview');
    assert.equal(continueBtnPreview.disabled, false);
    await act(async () => {
      continueBtnPreview.click();
    });
    assert.deepEqual(submittedPrompts, ['Continue']);

    // Intentional shared-preview restrictions: attachments, mic, pre-recording lang picker remain disabled
    assert.equal(attachBtnPreview.disabled, true);
    assert.equal(micBtnPreview.disabled, true);
    assert.equal(langBtnPreview.disabled, true);

    // 2. While isSubmittingFirstSharedMessage = true, authenticated shared preview composer & continuation chip block cleanly
    submittedPrompts = [];
    await act(async () => {
      root.render(
        wrapWithProviders(
          React.createElement(ChatArea as any, {
            activeChatId: null,
            messages: truncatedSharedMessages,
            isLoading: false,
            isNewChat: false,
            inputValue: 'Follow-up question',
            onInputChange: () => {},
            onSubmit: async (_atts: any[], override?: string | null) => {
              submittedPrompts.push(override || 'Follow-up question');
              return true;
            },
            isReadOnly: true,
            isSharedView: true,
            isAuthenticatedSharedPreview: true,
            isPublicSharedViewer: false,
            isSubmittingFirstSharedMessage: true,
            sharedSnapshot: { id: 'SharedPreview001', title: 'Preview Thread', mode: 'general', messages: truncatedSharedMessages }
          })
        )
      );
    });

    assert.equal(dom.queryByClass('composer-textarea').disabled, true);
    assert.equal(dom.queryByClass('composer-send-btn').disabled, true);
    assert.equal(dom.queryByClass('continuation-prompt-chip').disabled, true);

    // 3. Public Shared Viewer (isPublicSharedViewer = true, isAuthenticatedSharedPreview = false)
    await act(async () => {
      root.render(
        wrapWithProviders(
          React.createElement(ChatArea as any, {
            activeChatId: null,
            messages: truncatedSharedMessages,
            isLoading: false,
            isNewChat: false,
            inputValue: 'Typed text',
            onInputChange: () => {},
            onSubmit: async () => true,
            isReadOnly: true,
            isSharedView: true,
            isAuthenticatedSharedPreview: false,
            isPublicSharedViewer: true,
            sharedSnapshot: { id: 'SharedPreview001', title: 'Preview Thread', mode: 'general', messages: truncatedSharedMessages }
          })
        )
      );
    });

    const mainPublic = dom.queryByClass('chat-area-container');
    const sendBtnPublic = dom.queryByClass('composer-send-btn');
    assert.equal(mainPublic.classList.contains('is-read-only-view'), true);
    assert.equal(dom.queryByClass('composer-textarea').disabled, true);
    assert.equal(sendBtnPublic.disabled, true);
    assert.equal(sendBtnPublic.classList.contains('is-empty'), true);
    assert.equal(sendBtnPublic.getAttribute('aria-label'), 'Messaging disabled in read-only mode');
    assert.equal(dom.queryByClass('continuation-prompt-chip'), null);
    assert.equal(dom.queryByClass('composer-attach-btn').disabled, true);
    assert.equal(dom.queryByClass('composer-mic-btn').disabled, true);
    assert.equal(dom.queryByClass('composer-lang-btn').disabled, true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});
