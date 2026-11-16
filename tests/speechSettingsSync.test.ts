import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';
import { SettingsProvider, useSettings } from '../src/context/SettingsContext.jsx';
import { SpeechProvider, useSpeech } from '../src/context/SpeechContext.jsx';
import SettingsModal from '../src/components/settings/SettingsModal.jsx';
import {
  DEFAULT_SETTINGS,
  loadSettings as realLoadSettings,
  saveSettings as realSaveSettings,
  getSettingsStorageKey
} from '../src/services/userSettingsService.js';

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

interface MockVoice {
  voiceURI: string;
  name: string;
  lang: string;
  default: boolean;
}

class MockSpeechSynthesisUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  voice: MockVoice | null = null;
  lang = 'en-US';
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onboundary: ((e: { charIndex: number }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function createMockSpeechController(initialVoices: MockVoice[] = []) {
  let voices = [...initialVoices];
  const spokenUtterances: MockSpeechSynthesisUtterance[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let cancelCount = 0;

  const speechSynthesis: any = {
    speaking: false,
    pending: false,
    paused: false,
    onvoiceschanged: null,
    getVoices() {
      return voices;
    },
    speak(utterance: MockSpeechSynthesisUtterance) {
      spokenUtterances.push(utterance);
      speechSynthesis.speaking = true;
      utterance.onstart?.();
    },
    cancel() {
      cancelCount += 1;
      speechSynthesis.speaking = false;
      speechSynthesis.pending = false;
      speechSynthesis.paused = false;
    },
    resume() {
      speechSynthesis.paused = false;
    },
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb);
    }
  };

  return {
    speechSynthesis,
    spokenUtterances,
    getCancelCount() {
      return cancelCount;
    },
    setVoices(next: MockVoice[]) {
      voices = [...next];
      listeners.get('voiceschanged')?.forEach((cb) => cb());
      if (typeof speechSynthesis.onvoiceschanged === 'function') {
        speechSynthesis.onvoiceschanged();
      }
    }
  };
}

interface FakeElement {
  tagName: string;
  nodeName: string;
  type: string;
  nodeType: number;
  ownerDocument: any;
  parentNode: any;
  childNodes: any[];
  attributes: Record<string, string>;
  style: Record<string, any>;
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
  };
  value: string;
  defaultSelected: boolean;
  selected: boolean;
  multiple: boolean;
  readonly options: any[];
  selectedIndex: number;
  textContent: string;
  id: string;
  _listeners: Map<string, Set<(ev: any) => void>>;
  addEventListener: (type: string, cb: (ev: any) => void) => void;
  removeEventListener: (type: string, cb: (ev: any) => void) => void;
  dispatchEvent: (ev: any) => boolean;
  appendChild: (c: any) => any;
  removeChild: (c: any) => any;
  insertBefore: (c: any, ref: any) => any;
  hasChildNodes: () => boolean;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  hasAttribute: (k: string) => boolean;
  removeAttribute: (k: string) => void;
  focus: () => void;
  click: () => void;
  querySelectorAll: (selector: string) => any[];
}

function makeFakeElement(tag: string, doc: any): FakeElement {
  const classes = new Set<string>();
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    type: tag.toLowerCase() === 'select' ? 'select-one' : '',
    nodeType: 1,
    ownerDocument: doc,
    parentNode: null,
    childNodes: [],
    attributes: {},
    style: {},
    value: '',
    defaultSelected: false,
    selected: false,
    multiple: false,
    get options() {
      return this.childNodes.filter((c: any) => c.tagName === 'OPTION');
    },
    get selectedIndex() {
      return this.options.findIndex((o: any) => o.selected || o.value === this.value);
    },
    set selectedIndex(_idx: number) {},
    textContent: '',
    id: '',
    _listeners: new Map(),
    classList: {
      add(...names: string[]) {
        names.forEach((n) => classes.add(n));
      },
      remove(...names: string[]) {
        names.forEach((n) => classes.delete(n));
      },
      contains(name: string) {
        return classes.has(name);
      }
    },
    addEventListener(type: string, cb: (ev: any) => void) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: (ev: any) => void) {
      this._listeners.get(type)?.delete(cb);
    },
    dispatchEvent(ev: any) {
      if (!ev.target) ev.target = this;
      let cur: any = this;
      while (cur) {
        ev.currentTarget = cur;
        const set = cur._listeners?.get(ev.type);
        if (set) {
          for (const cb of Array.from(set) as Array<(e: any) => void>) {
            cb(ev);
          }
        }
        if (ev.bubbles === false) break;
        cur = cur.parentNode;
      }
      return true;
    },
    appendChild(c: any) {
      if (c.parentNode) c.parentNode.removeChild(c);
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c: any) {
      this.childNodes = this.childNodes.filter((x: any) => x !== c);
      c.parentNode = null;
      return c;
    },
    insertBefore(c: any, ref: any) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const idx = ref ? this.childNodes.indexOf(ref) : -1;
      if (idx >= 0) {
        this.childNodes.splice(idx, 0, c);
      } else {
        this.childNodes.push(c);
      }
      c.parentNode = this;
      return c;
    },
    hasChildNodes() {
      return this.childNodes.length > 0;
    },
    setAttribute(k: string, v: string) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
    },
    getAttribute(k: string) {
      return k in this.attributes ? this.attributes[k] : null;
    },
    hasAttribute(k: string) {
      return k in this.attributes;
    },
    removeAttribute(k: string) {
      delete this.attributes[k];
      if (k === 'id') this.id = '';
    },
    focus() {
      doc.activeElement = this;
    },
    click() {
      this.dispatchEvent({
        type: 'click',
        bubbles: true,
        cancelable: true,
        preventDefault() {},
        stopPropagation() {}
      });
    },
    querySelectorAll(selector: string) {
      const results: any[] = [];
      const visit = (node: any) => {
        for (const child of node.childNodes || []) {
          if (child.nodeType === 1) {
            if (selector.startsWith('#') && child.id === selector.slice(1)) {
              results.push(child);
            } else if (selector === 'button' && child.tagName === 'BUTTON') {
              results.push(child);
            } else if (selector === 'select' && child.tagName === 'SELECT') {
              results.push(child);
            }
            visit(child);
          }
        }
      };
      visit(this);
      return results;
    }
  };
  return el;
}

function installTestDomEnvironment(options?: {
  sessionStorage?: MockStorage;
  localStorage?: MockStorage;
  voices?: MockVoice[];
}) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevSessionStorage = (globalThis as any).sessionStorage;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevUtterance = (globalThis as any).SpeechSynthesisUtterance;
  const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

  const speechController = createMockSpeechController(
    options?.voices || [
      { voiceURI: 'VoiceAlpha', name: 'Voice Alpha', lang: 'en-US', default: false },
      { voiceURI: 'VoiceBeta', name: 'Voice Beta', lang: 'en-GB', default: false },
      { voiceURI: 'CloudVoice', name: 'Cloud Voice', lang: 'en-US', default: false },
      { voiceURI: 'CloudVoice2', name: 'Cloud Voice 2', lang: 'en-GB', default: false }
    ]
  );

  const windowListeners = new Map<string, Set<(ev: any) => void>>();

  const view: any = {
    HTMLIFrameElement: class {},
    HTMLSelectElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    speechSynthesis: speechController.speechSynthesis,
    SpeechSynthesisUtterance: MockSpeechSynthesisUtterance,
    matchMedia: () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    }),
    addEventListener(type: string, cb: (ev: any) => void) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: (ev: any) => void) {
      windowListeners.get(type)?.delete(cb);
    }
  };

  const docListeners = new Map<string, Set<(ev: any) => void>>();
  const doc: any = {
    nodeType: 9,
    documentElement: null as any,
    body: null as any,
    defaultView: view,
    activeElement: null,
    visibilityState: 'visible',
    createElement(tag: string) {
      return makeFakeElement(tag, doc);
    },
    createElementNS(_ns: string, tag: string) {
      return makeFakeElement(tag, doc);
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: text, textContent: text, ownerDocument: doc, parentNode: null };
    },
    addEventListener(type: string, cb: (ev: any) => void) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: (ev: any) => void) {
      docListeners.get(type)?.delete(cb);
    },
    querySelectorAll() {
      return [];
    }
  };
  doc.documentElement = makeFakeElement('html', doc);
  doc.body = makeFakeElement('body', doc);

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
  (globalThis as any).SpeechSynthesisUtterance = MockSpeechSynthesisUtterance;

  const container = makeFakeElement('div', doc);
  doc.body.appendChild(container);

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

    if (prevUtterance === undefined) delete (globalThis as any).SpeechSynthesisUtterance;
    else (globalThis as any).SpeechSynthesisUtterance = prevUtterance;
  };

  return {
    container,
    sessionStorage: sStorage,
    localStorage: lStorage,
    speech: speechController,
    restore
  };
}

interface FakeUser {
  uid: string;
  email: string;
  displayName?: string;
  isAnonymous?: boolean;
}

function createFakeAuthController(initialPersistedUser: FakeUser | null = null) {
  let persistedUser: FakeUser | null = initialPersistedUser;
  const activeListeners = new Set<(user: FakeUser | null) => void>();

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
    loginWithEmail: async (email: string) => {
      const uid = `fb-${email.trim().toLowerCase()}`;
      const user: FakeUser = { uid, email: email.trim(), displayName: email.split('@')[0] };
      persistedUser = user;
      notifyAll(user);
      return { user };
    },
    signupWithEmail: async (email: string) => {
      const uid = `fb-${email.trim().toLowerCase()}`;
      const user: FakeUser = { uid, email: email.trim(), displayName: '' };
      persistedUser = user;
      notifyAll(user);
      return { user };
    },
    logout: async () => {
      persistedUser = null;
      notifyAll(null);
    },
    getUserProfile: async () => null,
    saveUserProfile: async () => {}
  };

  return {
    authDeps,
    emitAuthChange(user: FakeUser | null) {
      persistedUser = user;
      notifyAll(user);
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

async function flush(ms = 15) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function collectButtonText(node: any): string {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue || '';
  const childText = (node.childNodes || []).map(collectButtonText).join('');
  return childText || node.textContent || '';
}

function mountAppHarness(
  container: any,
  authDeps: any,
  settingsDeps: any = null,
  options?: { renderModal?: boolean }
) {
  let latestAuth: any = null;
  let latestSettings: any = null;
  let latestSpeech: any = null;

  function Inspector() {
    latestAuth = useAuth();
    latestSettings = useSettings();
    latestSpeech = useSpeech();
    return null;
  }

  const root: Root = createRoot(container);

  const tree = React.createElement(
    AuthProvider as any,
    { authDeps },
    React.createElement(
      SettingsProvider as any,
      { settingsDeps },
      React.createElement(
        SpeechProvider as any,
        null,
        React.createElement(Inspector),
        options?.renderModal ? React.createElement(SettingsModal as any) : null
      )
    )
  );

  return {
    async mount() {
      await act(async () => {
        root.render(tree);
      });
      await flush();
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
    getAuth: () => latestAuth,
    getSettings: () => latestSettings,
    getSpeech: () => latestSpeech
  };
}

test('ORVIX-LOW-01: Startup syncs Firestore speech preferences to SpeechContext and waits for pending load before read-aloud starts', async () => {
  const localStorage = createMemoryStorage({
    orvix_speech_rate: '0.75',
    orvix_speech_voice_uri: 'StaleVoice'
  });
  const dom = installTestDomEnvironment({ localStorage });

  const alice: FakeUser = {
    uid: 'fb-alice',
    email: 'alice@example.com',
    displayName: 'Alice'
  };
  const auth = createFakeAuthController(alice);
  const deferredLoad = createDeferred<typeof DEFAULT_SETTINGS>();
  let loadCalls = 0;

  const settingsDeps = {
    loadSettings: async (uid: string | null) => {
      if (!uid) return { ...DEFAULT_SETTINGS };
      loadCalls += 1;
      return deferredLoad.promise;
    },
    saveSettings: async (_uid: string | null, partial: any, current: any) => ({
      ...current,
      ...partial
    })
  };

  const harness = mountAppHarness(dom.container, auth.authDeps, settingsDeps);

  try {
    await harness.mount();
    // Stale global keys must NOT leak into SettingsProvider-managed SpeechContext
    assert.equal(harness.getSpeech().speechRate, 1);
    assert.equal(harness.getSpeech().selectedVoiceURI, '');
    assert.ok(loadCalls >= 1);
    assert.equal(harness.getSettings().hasPendingSettingsLoad(), true);

    // Start playMessage while Firestore settings load is still in flight
    await act(async () => {
      harness.getSpeech().playMessage('msg-1', 'Hello Alice from Firestore.');
    });

    // Wait past the initial 50ms breather while Firestore load is still pending
    await flush(70);
    assert.equal(
      dom.speech.spokenUtterances.length,
      0,
      'Must wait for pending Firestore settings load before creating utterance'
    );

    // Resolve Firestore settings with saved cloud speech preferences
    await act(async () => {
      deferredLoad.resolve({
        ...DEFAULT_SETTINGS,
        speechRate: 1.5,
        speechVoiceURI: 'CloudVoice'
      });
    });
    await flush(30);

    // SpeechContext synced automatically at startup AND utterance spoke using Firestore values
    assert.equal(harness.getSettings().settings.speechRate, 1.5);
    assert.equal(harness.getSettings().settings.speechVoiceURI, 'CloudVoice');
    assert.equal(harness.getSpeech().speechRate, 1.5);
    assert.equal(harness.getSpeech().selectedVoiceURI, 'CloudVoice');
    assert.equal(dom.speech.spokenUtterances.length, 1);
    assert.equal(dom.speech.spokenUtterances[0].rate, 1.5);
    assert.equal(dom.speech.spokenUtterances[0].voice?.voiceURI, 'CloudVoice');

    await harness.unmount();
  } finally {
    dom.restore();
  }
});

test('ORVIX-LOW-01: SettingsModal does not overwrite newly selected speech preferences during slow async persistence', async () => {
  const dom = installTestDomEnvironment();
  const alice: FakeUser = { uid: 'fb-alice', email: 'alice@example.com', displayName: 'Alice' };
  const auth = createFakeAuthController(alice);

  let serverRecord = { ...DEFAULT_SETTINGS };
  const pendingSaves: Array<ReturnType<typeof createDeferred<typeof DEFAULT_SETTINGS>>> = [];

  const settingsDeps = {
    loadSettings: async () => ({ ...serverRecord }),
    saveSettings: async (_uid: string | null, partial: any, current: any) => {
      const next = { ...current, ...partial };
      const deferred = createDeferred<typeof DEFAULT_SETTINGS>();
      pendingSaves.push(deferred);
      serverRecord = next;
      return deferred.promise;
    }
  };

  const harness = mountAppHarness(dom.container, auth.authDeps, settingsDeps, { renderModal: true });

  try {
    await harness.mount();
    await act(async () => {
      harness.getSettings().openSettingsModal();
    });
    await flush();

    // Locate rendered SettingsModal controls: select for voice + '2.0x' rate button + preview button
    const selects = dom.container.querySelectorAll('select');
    assert.equal(selects.length, 1, 'Voice select should be rendered in open SettingsModal');
    const voiceSelect = selects[0];

    const buttons = dom.container.querySelectorAll('button');
    const rate2Btn = buttons.find((b: any) => collectButtonText(b).trim() === '2.0x');
    assert.ok(rate2Btn, '2.0x speech rate button should be rendered');

    // Change voice via SettingsModal select while saveSettings stays pending
    await act(async () => {
      voiceSelect.value = 'CloudVoice2';
      voiceSelect.dispatchEvent({
        type: 'change',
        bubbles: true,
        cancelable: true,
        target: voiceSelect,
        preventDefault() {},
        stopPropagation() {}
      });
    });

    // Change speech rate via SettingsModal button right afterward while first save is still pending
    await act(async () => {
      rate2Btn.click();
    });

    // Neither SettingsModal effects nor pending saves may snap preferences back to 1.0x / ''
    assert.equal(harness.getSpeech().selectedVoiceURI, 'CloudVoice2');
    assert.equal(harness.getSpeech().speechRate, 2);
    assert.equal(harness.getSettings().settings.speechVoiceURI, 'CloudVoice2');
    assert.equal(harness.getSettings().settings.speechRate, 2);
    assert.equal(harness.getSettings().isSaving, true);

    // Resolve the first save (only voice), then the second save (voice + rate 2.0)
    assert.equal(pendingSaves.length, 1, 'Second save should wait in queue behind first save');
    await act(async () => {
      pendingSaves[0].resolve({ ...DEFAULT_SETTINGS, speechVoiceURI: 'CloudVoice2' });
    });
    await flush();

    // After first save finishes, second queued save is now running; rate MUST still stay 2
    assert.equal(harness.getSpeech().selectedVoiceURI, 'CloudVoice2');
    assert.equal(harness.getSpeech().speechRate, 2);
    assert.equal(pendingSaves.length, 2);

    await act(async () => {
      pendingSaves[1].resolve({ ...DEFAULT_SETTINGS, speechVoiceURI: 'CloudVoice2', speechRate: 2 });
    });
    await flush();

    assert.equal(harness.getSettings().isSaving, false);
    assert.equal(harness.getSpeech().selectedVoiceURI, 'CloudVoice2');
    assert.equal(harness.getSpeech().speechRate, 2);

    // Preview button speaks with newly selected voice and rate
    const previewBtn = dom.container
      .querySelectorAll('button')
      .find((b: any) => collectButtonText(b).includes('Preview'));
    assert.ok(previewBtn, 'Preview button should be rendered');
    await act(async () => {
      previewBtn.click();
    });
    await flush(70);

    assert.equal(dom.speech.spokenUtterances.length, 1);
    assert.equal(dom.speech.spokenUtterances[0].rate, 2);
    assert.equal(dom.speech.spokenUtterances[0].voice?.voiceURI, 'CloudVoice2');
  } finally {
    await harness.unmount();
    dom.restore();
  }
});

test('ORVIX-LOW-01: Rapid consecutive speech preference updates serialize cleanly without losing earlier changes', async () => {
  const dom = installTestDomEnvironment();
  const alice: FakeUser = { uid: 'fb-alice', email: 'alice@example.com', displayName: 'Alice' };
  const auth = createFakeAuthController(alice);

  let persistedCloud = { ...DEFAULT_SETTINGS };
  const saveLog: Array<{ partial: any; snapshot: any; deferred: ReturnType<typeof createDeferred<any>> }> = [];

  const settingsDeps = {
    loadSettings: async () => ({ ...persistedCloud }),
    saveSettings: async (_uid: string | null, partial: any, current: any) => {
      const deferred = createDeferred<any>();
      saveLog.push({ partial, snapshot: { ...current }, deferred });
      return deferred.promise;
    }
  };

  const harness = mountAppHarness(dom.container, auth.authDeps, settingsDeps);

  try {
    await harness.mount();

    // Fire 4 rapid updates synchronously while first save is blocked
    let p1!: Promise<any>;
    let p2!: Promise<any>;
    let p3!: Promise<any>;
    let p4!: Promise<any>;

    await act(async () => {
      p1 = harness.getSettings().updateSettings({ speechRate: 1.25 });
      p2 = harness.getSettings().updateSettings({ speechVoiceURI: 'VoiceBeta' });
      p3 = harness.getSettings().updateSettings({ speechRate: 1.75 });
      p4 = harness.getSettings().updateSettings({ theme: 'light' });
    });

    // Immediate optimistic state reflects all 4 updates together
    assert.equal(harness.getSettings().settings.speechRate, 1.75);
    assert.equal(harness.getSettings().settings.speechVoiceURI, 'VoiceBeta');
    assert.equal(harness.getSettings().settings.theme, 'light');
    assert.equal(harness.getSpeech().speechRate, 1.75);
    assert.equal(harness.getSpeech().selectedVoiceURI, 'VoiceBeta');
    assert.equal(harness.getSettings().isSaving, true);

    // Strictly serialized: only 1 saveSettings call in flight initially
    assert.equal(saveLog.length, 1);

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        const entry = saveLog[i];
        persistedCloud = { ...entry.snapshot, ...entry.partial };
        entry.deferred.resolve({ ...persistedCloud });
      });
      await flush(5);
      // Earlier resolves must never wipe out the later optimistic fields
      assert.equal(harness.getSettings().settings.speechRate, 1.75);
      assert.equal(harness.getSettings().settings.speechVoiceURI, 'VoiceBeta');
      assert.equal(harness.getSettings().settings.theme, 'light');
    }

    await Promise.all([p1, p2, p3, p4]);

    assert.equal(saveLog.length, 4);
    assert.equal(harness.getSettings().isSaving, false);
    assert.deepEqual(
      {
        speechRate: persistedCloud.speechRate,
        speechVoiceURI: persistedCloud.speechVoiceURI,
        theme: persistedCloud.theme
      },
      {
        speechRate: 1.75,
        speechVoiceURI: 'VoiceBeta',
        theme: 'light'
      }
    );

    await harness.unmount();
  } finally {
    dom.restore();
  }
});

test('ORVIX-LOW-01: Account switching and logout isolate per-user speech preferences, stop active speech, and clear reading positions', async () => {
  const localStorage = createMemoryStorage();
  const dom = installTestDomEnvironment({ localStorage });

  const alice: FakeUser = { uid: 'fb-alice', email: 'alice@example.com', displayName: 'Alice' };
  const bob: FakeUser = { uid: 'fb-bob', email: 'bob@example.com', displayName: 'Bob' };
  const charlie: FakeUser = { uid: 'fb-charlie', email: 'charlie@example.com', displayName: 'Charlie' };

  const cloudByUser: Record<string, typeof DEFAULT_SETTINGS> = {
    [alice.uid]: { ...DEFAULT_SETTINGS, speechRate: 1.75, speechVoiceURI: 'VoiceAlpha' },
    [bob.uid]: { ...DEFAULT_SETTINGS, speechRate: 0.75, speechVoiceURI: 'VoiceBeta' }
  };

  const auth = createFakeAuthController(alice);
  let bobLoadDeferred: ReturnType<typeof createDeferred<typeof DEFAULT_SETTINGS>> | null = null;

  const settingsDeps = {
    loadSettings: async (uid: string | null) => {
      if (uid === bob.uid && bobLoadDeferred) {
        return bobLoadDeferred.promise;
      }
      if (uid && cloudByUser[uid]) {
        return { ...cloudByUser[uid] };
      }
      return { ...DEFAULT_SETTINGS };
    },
    saveSettings: async (uid: string | null, partial: any, current: any) => {
      const next = { ...current, ...partial };
      if (uid) cloudByUser[uid] = next;
      return next;
    }
  };

  const harness = mountAppHarness(dom.container, auth.authDeps, settingsDeps);

  try {
    await harness.mount();

    // Alice's prefs are loaded and active
    assert.equal(harness.getSpeech().speechRate, 1.75);
    assert.equal(harness.getSpeech().selectedVoiceURI, 'VoiceAlpha');

    // Start speaking and pause mid-way to build a saved reading position for Alice
    await act(async () => {
      harness.getSpeech().playMessage(
        'msg-alice',
        'First long sentence for Alice so it has characters to read aloud. Second sentence follows.'
      );
    });
    await flush(70);
    assert.equal(dom.speech.spokenUtterances.length, 1);

    // Simulate boundary progress then pause so readingPositions contains msg-alice
    await act(async () => {
      dom.speech.spokenUtterances[0].onboundary?.({ charIndex: 25 });
      harness.getSpeech().pauseSpeech();
    });
    assert.ok(harness.getSpeech().readingPositions['msg-alice']);

    // Resume playback, then log out while active
    await act(async () => {
      harness.getSpeech().resumeSpeech();
    });
    await flush(60);

    const cancelsBeforeLogout = dom.speech.getCancelCount();
    await act(async () => {
      await harness.getAuth().logout();
    });
    await flush();

    // Logout must stop speech, clear readingPositions, reset to defaults/guest, and NOT write global keys
    assert.ok(dom.speech.getCancelCount() > cancelsBeforeLogout);
    assert.equal(harness.getSpeech().speakingState, 'idle');
    assert.equal(harness.getSpeech().currentMessageId, null);
    assert.deepEqual(harness.getSpeech().readingPositions, {});
    assert.equal(harness.getSpeech().speechRate, 1);
    assert.equal(harness.getSpeech().selectedVoiceURI, '');
    assert.equal(localStorage.getItem('orvix_speech_rate'), null);
    assert.equal(localStorage.getItem('orvix_speech_voice_uri'), null);

    // Switch directly to Bob with a slow Firestore load: must NOT see Alice's 1.75/VoiceAlpha
    bobLoadDeferred = createDeferred<typeof DEFAULT_SETTINGS>();
    await act(async () => {
      auth.emitAuthChange(bob);
    });
    await flush(5);
    assert.equal(harness.getSpeech().speechRate, 1);
    assert.equal(harness.getSpeech().selectedVoiceURI, '');

    // Bob tries resume/play while Bob's load is pending -> waits for Bob's Firestore prefs
    await act(async () => {
      harness.getSpeech().playMessage('msg-bob', 'Hello Bob.');
    });
    await flush(70);
    assert.equal(dom.speech.spokenUtterances.length, 2, 'Should wait for Bob Firestore settings before speaking');

    await act(async () => {
      bobLoadDeferred!.resolve(cloudByUser[bob.uid]);
    });
    await flush(30);

    assert.equal(harness.getSpeech().speechRate, 0.75);
    assert.equal(harness.getSpeech().selectedVoiceURI, 'VoiceBeta');
    assert.equal(dom.speech.spokenUtterances.length, 3);
    assert.equal(dom.speech.spokenUtterances[2].rate, 0.75);
    assert.equal(dom.speech.spokenUtterances[2].voice?.voiceURI, 'VoiceBeta');

    // Direct account switch from Bob -> Charlie (new account with no saved prefs) isolates completely
    bobLoadDeferred = null;
    await act(async () => {
      auth.emitAuthChange(charlie);
    });
    await flush();

    assert.equal(harness.getSpeech().speakingState, 'idle');
    assert.equal(harness.getSpeech().speechRate, 1);
    assert.equal(harness.getSpeech().selectedVoiceURI, '');

    await harness.unmount();
  } finally {
    dom.restore();
  }
});

test('ORVIX-LOW-01: Guest Mode preserves localStorage fallback & resetToDefaults, and standalone SpeechProvider fallback still works', async () => {
  const localStorage = createMemoryStorage();
  const dom = installTestDomEnvironment({ localStorage });
  const auth = createFakeAuthController(null);

  // Use real userSettingsService loadSettings/saveSettings (with localStorage fallback when Firebase is offline/unconfigured)
  const realDeps = {
    loadSettings: realLoadSettings,
    saveSettings: realSaveSettings
  };

  try {
    // 1. Guest session updates & persists to per-guest storage key only
    const session1 = mountAppHarness(dom.container, auth.authDeps, realDeps);
    await session1.mount();

    await act(async () => {
      session1.getAuth().continueAsGuest('GuestOne');
    });
    await flush();

    assert.equal(session1.getSpeech().speechRate, 1);
    assert.equal(session1.getSpeech().selectedVoiceURI, '');

    await act(async () => {
      await session1.getSettings().updateSettings({
        speechRate: 1.5,
        speechVoiceURI: 'VoiceAlpha'
      });
    });

    assert.equal(session1.getSpeech().speechRate, 1.5);
    assert.equal(session1.getSpeech().selectedVoiceURI, 'VoiceAlpha');
    assert.equal(localStorage.getItem('orvix_speech_rate'), null);
    assert.equal(localStorage.getItem('orvix_speech_voice_uri'), null);

    const guestKey = getSettingsStorageKey(session1.getAuth().currentUser.uid);
    assert.equal(guestKey, 'orvix_guest_settings');
    const storedGuest = JSON.parse(localStorage.getItem(guestKey)!);
    assert.equal(storedGuest.speechRate, 1.5);
    assert.equal(storedGuest.speechVoiceURI, 'VoiceAlpha');

    await session1.unmount();

    // 2. Simulated Guest reload restores saved guest speech settings & supports resetToDefaults
    const session2 = mountAppHarness(dom.container, auth.authDeps, realDeps);
    await session2.mount();

    assert.equal(session2.getAuth().currentUser?.isAnonymous, true);
    assert.equal(session2.getSpeech().speechRate, 1.5);
    assert.equal(session2.getSpeech().selectedVoiceURI, 'VoiceAlpha');

    await act(async () => {
      await session2.getSettings().resetToDefaults();
    });
    assert.equal(session2.getSettings().settings.speechRate, 1);
    assert.equal(session2.getSettings().settings.speechVoiceURI, '');
    assert.equal(session2.getSpeech().speechRate, 1);
    assert.equal(session2.getSpeech().selectedVoiceURI, '');

    await session2.unmount();

    // 3. Standalone SpeechProvider (without SettingsProvider) still uses global localStorage keys safely
    localStorage.setItem('orvix_speech_rate', '1.25');
    localStorage.setItem('orvix_speech_voice_uri', 'VoiceBeta');
    let standaloneSpeech: any = null;
    function StandaloneReader() {
      standaloneSpeech = useSpeech();
      return null;
    }
    const standaloneRoot = createRoot(dom.container as any);
    await act(async () => {
      standaloneRoot.render(
        React.createElement(SpeechProvider as any, null, React.createElement(StandaloneReader))
      );
    });
    assert.equal(standaloneSpeech.speechRate, 1.25);
    assert.equal(standaloneSpeech.selectedVoiceURI, 'VoiceBeta');
    await act(async () => {
      standaloneSpeech.setSpeechRate(2);
      standaloneSpeech.setSelectedVoiceURI('CloudVoice');
    });
    assert.equal(localStorage.getItem('orvix_speech_rate'), '2');
    assert.equal(localStorage.getItem('orvix_speech_voice_uri'), 'CloudVoice');
    await act(async () => {
      standaloneRoot.unmount();
    });
  } finally {
    dom.restore();
  }
});
