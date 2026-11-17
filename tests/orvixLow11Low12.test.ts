import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import {
  getUtf8ByteLength,
  enforceFirestoreMessageSizeLimit,
  sanitizeMessageForStorage,
  buildFirestoreMessagePayload,
  MAX_FIRESTORE_MESSAGE_BYTES
} from '../src/services/chatStorageService.js';
import ImageAttachmentCard from '../src/components/chat/ImageAttachmentCard.jsx';
import AttachmentCard from '../src/components/chat/AttachmentCard.jsx';

let cachedCreateRoot: ((container: any) => Root) | null = null;
async function getCreateRoot() {
  if (!cachedCreateRoot) {
    const mod = await import('react-dom/client');
    cachedCreateRoot = mod.createRoot;
  }
  return cachedCreateRoot;
}

function installRichTestDomEnvironment() {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  const prevHTMLElement = (globalThis as any).HTMLElement;

  const listenerStore = new WeakMap<object, Map<string, Set<{ fn: Function; capture: boolean }>>>();
  const addEv = (target: object, type: string, fn: Function, opts?: any) => {
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
  const removeEv = (target: object, type: string, fn: Function, opts?: any) => {
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
    tabIndex = 0;

    constructor(tag: string, doc: any) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
    }

    get classList() {
      const self = this;
      const getTokens = () => self.className.split(/\s+/).filter(Boolean);
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
        }
      };
    }

    setAttribute(name: string, value: string) {
      this.attributes.set(name, String(value));
      if (name === 'class') this.className = String(value);
      else if (name === 'id') this.id = String(value);
    }

    getAttribute(name: string) {
      if (name === 'class') return this.className || null;
      if (name === 'id') return this.id || null;
      return this.attributes.has(name) ? this.attributes.get(name)! : null;
    }

    removeAttribute(name: string) {
      this.attributes.delete(name);
      if (name === 'class') this.className = '';
      else if (name === 'id') this.id = '';
      else if (name === 'disabled') this.disabled = false;
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

    addEventListener(type: string, fn: Function, opts?: any) {
      addEv(this, type, fn, opts);
    }
    removeEventListener(type: string, fn: Function, opts?: any) {
      removeEv(this, type, fn, opts);
    }
    dispatchEvent() { return true; }
    focus() {}
    blur() {}
    click() {}
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }

  const view: any = {
    HTMLIFrameElement: class {},
    HTMLElement: FakeElement,
    innerWidth: 1024,
    innerHeight: 768,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type: string, fn: Function, opts?: any) { addEv(view, type, fn, opts); },
    removeEventListener(type: string, fn: Function, opts?: any) { removeEv(view, type, fn, opts); }
  };

  const doc: any = {
    nodeType: 9,
    activeElement: null,
    createElement(tag: string) {
      return new FakeElement(tag, doc);
    },
    createElementNS(_ns: string, tag: string) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: String(text), parentNode: null };
    },
    addEventListener(type: string, fn: Function, opts?: any) { addEv(doc, type, fn, opts); },
    removeEventListener(type: string, fn: Function, opts?: any) { removeEv(doc, type, fn, opts); },
    body: null as any
  };
  doc.body = new FakeElement('body', doc);
  view.document = doc;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = view;
  (globalThis as any).document = doc;
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

  const container = new FakeElement('div', doc);
  doc.body.appendChild(container);

  return {
    container,
    restore() {
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
      if (prevDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDocument;
      if (prevActEnv === undefined) delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
      else (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      if (prevHTMLElement === undefined) delete (globalThis as any).HTMLElement;
      else (globalThis as any).HTMLElement = prevHTMLElement;
    }
  };
}

test('ORVIX-LOW-11: UTF-8 byte length measurement and Firestore message size enforcement', () => {
  // 1. ASCII vs Multibyte UTF-8 byte length
  const asciiText = 'Hello World 123!';
  assert.equal(getUtf8ByteLength(asciiText), 16);

  // Urdu / Arabic / Emoji multibyte characters (each emoji/Urdu char can be 2-4 bytes in UTF-8)
  const multibyteText = 'سلام دنیا 🌍🚀';
  const utf8Bytes = new TextEncoder().encode(multibyteText).length;
  assert.equal(getUtf8ByteLength(multibyteText), utf8Bytes);

  // 2. Messages below or at 100 KB limit remain un-truncated
  const smallMessage = 'A'.repeat(50000); // 50 KB
  const smallEnforced = enforceFirestoreMessageSizeLimit(smallMessage);
  assert.equal(smallEnforced.truncated, false);
  assert.equal(smallEnforced.content, smallMessage);

  // 3. Oversized messages above 100 KB limit get safely truncated with notice
  const largeMessage = 'B'.repeat(120000); // 120 KB
  const largeEnforced = enforceFirestoreMessageSizeLimit(largeMessage);
  assert.equal(largeEnforced.truncated, true);
  assert.ok(largeEnforced.content.includes('[Notice: Message exceeded 100 KB Firestore storage limit and was truncated.]'));
  assert.ok(getUtf8ByteLength(largeEnforced.content) <= MAX_FIRESTORE_MESSAGE_BYTES);

  // 4. sanitizeMessageForStorage and buildFirestoreMessagePayload enforce limit consistently
  const oversizedMsg = {
    id: 'msg-over-1',
    sender: 'user',
    content: 'C'.repeat(150000),
    alternatives: [
      { id: 'alt-1', content: 'D'.repeat(110000) }
    ]
  };

  const sanitized = sanitizeMessageForStorage(oversizedMsg);
  assert.equal((sanitized as any).wasTruncated, true);
  assert.ok(sanitized.content.includes('[Notice:'));
  assert.equal((sanitized.alternatives[0] as any).wasTruncated, true);
  assert.ok(sanitized.alternatives[0].content.includes('[Notice:'));

  const payload = buildFirestoreMessagePayload(oversizedMsg);
  assert.ok(getUtf8ByteLength(payload.content) <= MAX_FIRESTORE_MESSAGE_BYTES);
  assert.ok(getUtf8ByteLength(payload.alternatives[0].content) <= MAX_FIRESTORE_MESSAGE_BYTES);
});

test('ORVIX-LOW-12: ImageAttachmentCard and AttachmentCard handle attachment prop transitioning between valid and falsy values without hook violations', async () => {
  const dom = installRichTestDomEnvironment();
  const createRoot = await getCreateRoot();
  const root = createRoot(dom.container as unknown as Element);

  const validAttachment = {
    id: 'att-101',
    name: 'document.pdf',
    size: 2048,
    type: 'application/pdf',
    extension: 'pdf'
  };

  const validImageAttachment = {
    id: 'att-102',
    name: 'photo.png',
    size: 4096,
    type: 'image/png',
    extension: 'png',
    previewUrl: 'data:image/png;base64,iVBORw0KGgo='
  };

  try {
    // 1. Render AttachmentCard with valid attachment -> update to null -> update back to valid attachment
    await act(async () => {
      root.render(React.createElement(AttachmentCard, { attachment: validAttachment }));
    });

    await act(async () => {
      root.render(React.createElement(AttachmentCard as any, { attachment: null }));
    });

    await act(async () => {
      root.render(React.createElement(AttachmentCard, { attachment: validAttachment }));
    });

    // 2. Render ImageAttachmentCard with valid image -> update to undefined -> update back to valid image
    await act(async () => {
      root.render(React.createElement(ImageAttachmentCard, { attachment: validImageAttachment }));
    });

    await act(async () => {
      root.render(React.createElement(ImageAttachmentCard as any, { attachment: undefined }));
    });

    await act(async () => {
      root.render(React.createElement(ImageAttachmentCard, { attachment: validImageAttachment }));
    });

    assert.ok(true, 'Conditional hook order verified successfully across valid and falsy attachment prop transitions');
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
  }
});
