import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  setupVoiceWebSocketServer,
  getActiveVoiceSessions,
  normalizeAndValidateVoiceLanguage,
  resetVoiceWebSocketStateForTesting
} from '../server/voiceWebSocketSubsystem.ts';
import {
  resetFirebaseAuthForTesting,
  setTestFirebaseProjectId,
  setTestPublicKey
} from '../server/firebaseAuthHelper.ts';
import { resetRateLimitersForTesting } from '../server/rateLimiter.ts';
import { resetRedisClientForTesting } from '../server/redisClient.ts';
import { setAuthInstanceForTesting } from '../src/services/authService.js';
import { VoiceStreamClient } from '../src/services/voiceStreamClient.js';
import { useVoiceDictation } from '../src/hooks/useVoiceDictation.js';
import VoiceDictationDock from '../src/components/chat/VoiceDictationDock.jsx';

function buildSignedJwt(
  claims: Record<string, any>,
  privateKey: crypto.KeyObject,
  kid = 'voice-lang-kid'
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function setupAuthFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = 'orvix-voice-lang-test';
  const kid = 'voice-lang-kid';
  setTestFirebaseProjectId(projectId);
  setTestPublicKey(kid, publicKey.export({ type: 'spki', format: 'pem' }).toString());

  const nowSec = Math.floor(Date.now() / 1000);
  const token = buildSignedJwt(
    {
      sub: 'voice-lang-user-1',
      user_id: 'voice-lang-user-1',
      email: 'voice-lang@orvix.test',
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      iat: nowSec - 30,
      exp: nowSec + 3600
    },
    privateKey,
    kid
  );
  return { token, projectId };
}

interface VoiceTestServer {
  server: http.Server;
  wss: WebSocketServer;
  wsUrl: string;
  close: () => Promise<void>;
}

async function startVoiceTestServer(): Promise<VoiceTestServer> {
  const app = express();
  const server = http.createServer(app);
  const wss = setupVoiceWebSocketServer(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${addr.port}/api/voice-stream`;

  const close = async () => {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch (_) {}
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.removeAllListeners('upgrade');
    try {
      (server as any).closeAllConnections?.();
    } catch (_) {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetVoiceWebSocketStateForTesting();
    await resetRedisClientForTesting();
  };

  return { server, wss, wsUrl, close };
}

async function waitForMessage(
  messages: any[],
  predicate: (m: any) => boolean,
  timeoutMs = 2500
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for WebSocket message. Received: ${JSON.stringify(messages)}`);
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

function installDictationDom(options?: {
  localStorage?: MockStorage;
  SpeechRecognition?: any;
  WebSocketImpl?: any;
}) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevLocalStorage = (globalThis as any).localStorage;
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevWebSocket = (globalThis as any).WebSocket;
  const prevAudioContext = (globalThis as any).AudioContext;
  const prevRAF = (globalThis as any).requestAnimationFrame;
  const prevCAF = (globalThis as any).cancelAnimationFrame;
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

    constructor(tag: string, doc: any) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
    }
    get nodeName() {
      return this.tagName;
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

  const fakeTrack = {
    readyState: 'live',
    enabled: true,
    muted: false,
    onended: null as any,
    onmute: null as any,
    stop() {
      this.readyState = 'ended';
    }
  };
  const fakeStream = {
    active: true,
    getAudioTracks: () => [fakeTrack],
    getTracks: () => [fakeTrack]
  };

  class FakeAudioContext {
    sampleRate = 16000;
    state = 'running';
    destination = {};
    resume() {
      return Promise.resolve();
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 128,
        smoothingTimeConstant: 0.65,
        frequencyBinCount: 64,
        getByteFrequencyData() {}
      };
    }
    createScriptProcessor() {
      return {
        onaudioprocess: null,
        connect() {},
        disconnect() {}
      };
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  const fakeNav: any = {
    userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
    language: 'en-US',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    mediaDevices: {
      getUserMedia: async () => fakeStream
    }
  };

  const ls = options?.localStorage || createMemoryStorage();

  const view: any = {
    HTMLIFrameElement: class {},
    localStorage: ls,
    navigator: fakeNav,
    WebSocket: options?.WebSocketImpl || WebSocket,
    AudioContext: FakeAudioContext,
    SpeechRecognition: options?.SpeechRecognition || undefined,
    webkitSpeechRecognition: options?.SpeechRecognition || undefined,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
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
    visibilityState: 'visible',
    activeElement: null,
    defaultView: view,
    documentElement: null as any,
    body: null as any,
    createElement(tag: string) {
      return new FakeElement(tag, doc);
    },
    createElementNS(_ns: string, tag: string) {
      return new FakeElement(tag, doc);
    },
    createTextNode(v: string) {
      return { nodeType: 3, nodeValue: v, parentNode: null };
    },
    createComment(v: string) {
      return { nodeType: 8, nodeValue: v, parentNode: null };
    },
    addEventListener(type: string, fn: Function) {
      addEv(this, type, fn);
    },
    removeEventListener(type: string, fn: Function) {
      removeEv(this, type, fn);
    }
  };

  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.appendChild(doc.body);
  view.document = doc;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = view;
  (globalThis as any).document = doc;
  (globalThis as any).localStorage = ls;
  Object.defineProperty(globalThis, 'navigator', {
    value: fakeNav,
    configurable: true,
    writable: true
  });
  (globalThis as any).WebSocket = view.WebSocket;
  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).requestAnimationFrame = view.requestAnimationFrame;
  (globalThis as any).cancelAnimationFrame = view.cancelAnimationFrame;

  const findAll = (rootNode: any, predicate: (el: any) => boolean, acc: any[] = []): any[] => {
    if (!rootNode) return acc;
    if (rootNode.nodeType === 1 && predicate(rootNode)) acc.push(rootNode);
    for (const c of rootNode.childNodes || []) findAll(c, predicate, acc);
    return acc;
  };

  return {
    doc,
    view,
    localStorage: ls,
    findAll,
    cleanup() {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      (globalThis as any).window = prevWindow;
      (globalThis as any).document = prevDocument;
      (globalThis as any).localStorage = prevLocalStorage;
      if (prevNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
      }
      (globalThis as any).WebSocket = prevWebSocket;
      (globalThis as any).AudioContext = prevAudioContext;
      (globalThis as any).requestAnimationFrame = prevRAF;
      (globalThis as any).cancelAnimationFrame = prevCAF;
    }
  };
}

const originalRateLimitKeyPrefix = process.env.RATE_LIMIT_KEY_PREFIX;
let testSeq = 0;

beforeEach(() => {
  testSeq += 1;
  process.env.RATE_LIMIT_KEY_PREFIX = `orvix:test:voice_lang_sync:${process.pid}:${testSeq}`;
});

after(() => {
  if (originalRateLimitKeyPrefix === undefined) {
    delete process.env.RATE_LIMIT_KEY_PREFIX;
  } else {
    process.env.RATE_LIMIT_KEY_PREFIX = originalRateLimitKeyPrefix;
  }
});

test('ORVIX-LOW-04 unit: normalizeAndValidateVoiceLanguage normalizes valid BCP-47 tags and rejects invalid or unsupported ones', () => {
  assert.deepEqual(normalizeAndValidateVoiceLanguage('en-US'), {
    valid: true,
    language: 'en-US',
    iso639: 'en'
  });
  assert.deepEqual(normalizeAndValidateVoiceLanguage('  es-es '), {
    valid: true,
    language: 'es-ES',
    iso639: 'es'
  });
  assert.deepEqual(normalizeAndValidateVoiceLanguage('ur-pk'), {
    valid: true,
    language: 'ur-PK',
    iso639: 'ur'
  });
  assert.deepEqual(normalizeAndValidateVoiceLanguage('fr'), {
    valid: true,
    language: 'fr',
    iso639: 'fr'
  });

  for (const invalid of ['', '   ', null, undefined, 42, {}, 'english', 'xx-XX', 'tlh-AA', 'en-US; rm -rf', 'en_US']) {
    const res = normalizeAndValidateVoiceLanguage(invalid);
    assert.equal(res.valid, false, `Expected ${JSON.stringify(invalid)} to be rejected`);
  }
});

test('ORVIX-LOW-04 backend WS: live config updates active session language and subsequent audio chunks use new language while initial language remains functional', async () => {
  resetVoiceWebSocketStateForTesting();
  resetFirebaseAuthForTesting();
  resetRateLimitersForTesting();
  const { token } = setupAuthFixture();

  const prevGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_test_fake_voice_lang_sync_key';

  const recordedGroqCalls: Array<{ language: string | null; byteLength: number }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input?.url || '';
    if (urlStr.includes('api.groq.com')) {
      const formData = init?.body as FormData;
      const langVal = formData?.get('language');
      const fileVal = formData?.get('file') as Blob | null;
      const byteLength = fileVal ? fileVal.size : 0;
      const langStr = typeof langVal === 'string' ? langVal : null;
      recordedGroqCalls.push({ language: langStr, byteLength });

      const textByLang: Record<string, string> = {
        fr: 'Bonjour Orvix',
        en: 'Hello team',
        es: 'Hola mundo',
        ur: 'سلام دنیا'
      };

      return new Response(
        JSON.stringify({
          text: textByLang[langStr || 'en'] || 'Fallback speech',
          language: langStr || 'en',
          duration: 1.0
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;

  const srv = await startVoiceTestServer();
  const messages: any[] = [];

  try {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`${srv.wsUrl}?token=${encodeURIComponent(token)}`);
      sock.on('message', (raw) => {
        try {
          messages.push(JSON.parse(raw.toString()));
        } catch (_) {}
      });
      sock.on('open', () => resolve(sock));
      sock.on('error', reject);
    });

    await waitForMessage(messages, (m) => m.type === 'authenticated');

    // 1. Existing initial-language configuration via 'start' remains functional ('fr-FR')
    ws.send(
      JSON.stringify({
        type: 'start',
        format: { sampleRate: 16000, channels: 1, bitDepth: 16 },
        language: 'fr-FR'
      })
    );
    const readyMsg = await waitForMessage(messages, (m) => m.type === 'ready');
    assert.equal(readyMsg.language, 'fr-FR');
    assert.equal(getActiveVoiceSessions()[0].language, 'fr-FR');

    // Send first chunk (~16KB = 500ms) in French -> triggers initial incremental pass
    ws.send(Buffer.alloc(16000, 1));
    const frTranscript = await waitForMessage(
      messages,
      (m) => m.type === 'transcription' && m.language === 'fr-FR'
    );
    assert.equal(frTranscript.text, 'Bonjour Orvix');
    assert.equal(recordedGroqCalls[0]?.language, 'fr');

    // 2. Switch language mid-stream to Spanish ('es-ES') via { type: 'config', language }
    ws.send(JSON.stringify({ type: 'config', language: 'es-ES' }));
    const esConfigAck = await waitForMessage(
      messages,
      (m) => m.type === 'config' && m.language === 'es-ES'
    );
    assert.equal(esConfigAck.updated, true);
    assert.equal(esConfigAck.previousLanguage, 'fr-FR');
    assert.equal(getActiveVoiceSessions()[0].language, 'es-ES');

    // Wait >= 600ms so incremental threshold triggers cleanly with new chunk
    await new Promise((r) => setTimeout(r, 650));

    // Send subsequent Spanish PCM chunk -> must transcribe with language='es' and preserve French prefix
    ws.send(Buffer.alloc(12800, 2));
    const esTranscript = await waitForMessage(
      messages,
      (m) => m.type === 'transcription' && m.language === 'es-ES'
    );
    assert.equal(recordedGroqCalls[1]?.language, 'es');
    assert.match(esTranscript.text, /Bonjour Orvix/);
    assert.match(esTranscript.text, /Hola mundo/);

    // 3. Language update while paused also persists cleanly across resume + subsequent audio + stop
    ws.send(JSON.stringify({ type: 'pause' }));
    await waitForMessage(messages, (m) => m.type === 'state' && m.state === 'paused');

    ws.send(JSON.stringify({ type: 'config', language: 'ur-PK' }));
    const urConfigAck = await waitForMessage(
      messages,
      (m) => m.type === 'config' && m.language === 'ur-PK'
    );
    assert.equal(urConfigAck.updated, true);
    assert.equal(getActiveVoiceSessions()[0].language, 'ur-PK');

    ws.send(JSON.stringify({ type: 'resume' }));
    await waitForMessage(messages, (m) => m.type === 'state' && m.state === 'listening');

    ws.send(Buffer.alloc(8000, 3));
    ws.send(JSON.stringify({ type: 'stop' }));
    const doneMsg = await waitForMessage(messages, (m) => m.type === 'done');
    assert.equal(doneMsg.language, 'ur-PK');
    assert.equal(recordedGroqCalls[2]?.language, 'ur');
    assert.match(doneMsg.text, /Hola mundo/);
    assert.match(doneMsg.text, /سلام دنیا/);

    ws.close();
  } finally {
    globalThis.fetch = origFetch;
    if (prevGroq !== undefined) process.env.GROQ_API_KEY = prevGroq;
    else delete process.env.GROQ_API_KEY;
    resetVoiceWebSocketStateForTesting();
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();
    await srv.close();
  }
});

test('ORVIX-LOW-04 backend WS: invalid language updates are rejected safely without breaking active streaming', async () => {
  resetVoiceWebSocketStateForTesting();
  resetFirebaseAuthForTesting();
  resetRateLimitersForTesting();
  const { token } = setupAuthFixture();

  const prevGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_test_fake_voice_invalid_lang_key';

  const capturedLangs: Array<string | null> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input?.url || '';
    if (urlStr.includes('api.groq.com')) {
      const fd = init?.body as FormData;
      const langVal = fd?.get('language');
      capturedLangs.push(typeof langVal === 'string' ? langVal : null);
      return new Response(
        JSON.stringify({ text: 'Still in English', language: langVal || 'en', duration: 0.8 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;

  const srv = await startVoiceTestServer();
  const messages: any[] = [];

  try {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`${srv.wsUrl}?token=${encodeURIComponent(token)}`);
      sock.on('message', (raw) => {
        try {
          messages.push(JSON.parse(raw.toString()));
        } catch (_) {}
      });
      sock.on('open', () => resolve(sock));
      sock.on('error', reject);
    });

    await waitForMessage(messages, (m) => m.type === 'authenticated');

    ws.send(
      JSON.stringify({
        type: 'start',
        format: { sampleRate: 16000, channels: 1, bitDepth: 16 },
        language: 'en-US'
      })
    );
    await waitForMessage(messages, (m) => m.type === 'ready');

    // Attempt several invalid language configs mid-session
    ws.send(JSON.stringify({ type: 'config', language: 'xx-INVALID' }));
    const err1 = await waitForMessage(
      messages,
      (m) => m.type === 'error' && m.code === 'INVALID_LANGUAGE'
    );
    assert.equal(err1.recoverable, true);
    assert.equal(err1.canFallback, false);
    assert.equal(err1.language, 'en-US');
    assert.equal(getActiveVoiceSessions()[0].language, 'en-US');

    ws.send(JSON.stringify({ type: 'config', language: '' }));
    ws.send(JSON.stringify({ type: 'config', language: 999 }));
    ws.send(JSON.stringify({ type: 'config' }));

    await new Promise((r) => setTimeout(r, 50));
    const invalidErrors = messages.filter((m) => m.type === 'error');
    assert.equal(invalidErrors.length, 4);
    assert.equal(invalidErrors[3].code, 'INVALID_CONFIG');

    // Session MUST still be active and listening in 'en-US'
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(getActiveVoiceSessions()[0].state, 'listening');
    assert.equal(getActiveVoiceSessions()[0].language, 'en-US');

    // Subsequent audio continues using 'en-US' -> 'en'
    ws.send(Buffer.alloc(16000, 4));
    ws.send(JSON.stringify({ type: 'stop' }));
    const doneMsg = await waitForMessage(messages, (m) => m.type === 'done');
    assert.equal(doneMsg.text, 'Still in English');
    assert.ok(capturedLangs.length >= 1);
    assert.ok(capturedLangs.every((l) => l === 'en'));

    ws.close();
  } finally {
    globalThis.fetch = origFetch;
    if (prevGroq !== undefined) process.env.GROQ_API_KEY = prevGroq;
    else delete process.env.GROQ_API_KEY;
    resetVoiceWebSocketStateForTesting();
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();
    await srv.close();
  }
});

test('ORVIX-LOW-04 client+hook+UI: UI selector syncs immediately via WS config, deduplicates unchanged selects, reconciles rejected updates, and handles disconnect safely', async () => {
  resetVoiceWebSocketStateForTesting();
  resetFirebaseAuthForTesting();
  resetRateLimitersForTesting();
  const { token } = setupAuthFixture();

  const prevGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_test_fake_hook_sync_key';

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input?.url || '';
    if (urlStr.includes('api.groq.com')) {
      const fd = init?.body as FormData;
      const langVal = fd?.get('language');
      return new Response(
        JSON.stringify({ text: `chunk-${langVal}`, language: langVal || 'en', duration: 0.5 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;

  setAuthInstanceForTesting({
    currentUser: {
      uid: 'voice-lang-user-1',
      getIdToken: async () => token
    }
  } as any);

  // Wrap ws.WebSocket to count outbound JSON control messages sent by VoiceStreamClient
  const sentControlMessages: any[] = [];
  class SpyWebSocket extends WebSocket {
    constructor(address: any, protocols?: any, options?: any) {
      super(address, protocols, options);
    }
    override send(data: any, ...args: any[]) {
      if (typeof data === 'string') {
        try {
          sentControlMessages.push(JSON.parse(data));
        } catch (_) {}
      }
      return (super.send as any)(data, ...args);
    }
  }

  const dom = installDictationDom({
    localStorage: createMemoryStorage({ orvix_dictation_lang: 'en-US' }),
    WebSocketImpl: SpyWebSocket
  });
  const srv = await startVoiceTestServer();

  let hookApi: any = null;
  let root: Root | null = null;

  function TestHarness({ wsUrl, authToken }: { wsUrl: string; authToken: string }) {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const menuRef = React.useRef(null);
    const dictation: any = (useVoiceDictation as any)({
      inputValue: '',
      onInputChange: () => {},
      enableWebSocketStreaming: true,
      webSocketUrl: wsUrl,
      authToken
    });
    hookApi = dictation;

    const activeLang =
      dictation.supportedLanguages.find((l: any) => l.code === dictation.selectedLanguage) ||
      dictation.supportedLanguages[0];

    return React.createElement(VoiceDictationDock as any, {
      recordingState: dictation.recordingState,
      isListening: dictation.isListening,
      isPaused: dictation.isPaused,
      isRequesting: dictation.isRequesting,
      isStreamingWebSocket: dictation.isStreamingWebSocket,
      formattedDuration: dictation.formattedDuration,
      audioLevel: dictation.audioLevel,
      waveformBars: dictation.waveformBars,
      activeLang,
      supportedLanguages: dictation.supportedLanguages,
      selectedLanguage: dictation.selectedLanguage,
      langMenuOpen: menuOpen,
      langMenuRef: menuRef,
      onToggleLangMenu: () => setMenuOpen((p) => !p),
      onSelectLanguage: (code: string) => {
        dictation.setSelectedLanguage(code);
        setMenuOpen(false);
      },
      onPauseListening: dictation.pauseListening,
      onResumeListening: dictation.resumeListening,
      onStopListening: dictation.stopListening,
      onCancelListening: dictation.cancelListening
    });
  }

  try {
    const container = dom.doc.createElement('div');
    dom.doc.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(TestHarness, { wsUrl: srv.wsUrl, authToken: token }));
    });

    // Start active WebSocket dictation
    await act(async () => {
      await hookApi.startListening();
    });

    assert.equal(hookApi.isStreamingWebSocket, true);
    assert.equal(hookApi.recordingState, 'listening');
    assert.equal(getActiveVoiceSessions().length, 1);
    assert.equal(getActiveVoiceSessions()[0].language, 'en-US');

    // Helper to read displayed language code from VoiceDictationDock pill
    const getDisplayedPillCode = () => {
      const codeEl = dom.findAll(container, (el) => el.className === 'lang-code')[0];
      return codeEl?.textContent;
    };
    assert.equal(getDisplayedPillCode(), 'EN');

    // 1. Selecting the SAME language ('en-US') must NOT send an unnecessary WS config frame
    const configCountBeforeSame = sentControlMessages.filter((m) => m.type === 'config').length;
    await act(async () => {
      hookApi.setSelectedLanguage('en-US');
    });
    assert.equal(
      sentControlMessages.filter((m) => m.type === 'config').length,
      configCountBeforeSame,
      'Must not send unnecessary config message when language is unchanged'
    );

    // 2. Open VoiceDictationDock language menu and click Español ('es-ES')
    const langBtn = dom.findAll(container, (el) => (el.className || '').includes('dictation-lang-btn'))[0];
    await act(async () => {
      langBtn.click();
    });
    const esOption = dom
      .findAll(container, (el) => (el.className || '').includes('dictation-lang-option'))
      .find((btn) => btn.textContent.includes('Español'));
    assert.ok(esOption, 'Expected Español menu item in VoiceDictationDock');

    await act(async () => {
      esOption.click();
      await new Promise((r) => setTimeout(r, 60));
    });

    // Verify immediate WS config delivery + backend state + UI pill sync + localStorage update
    const esConfigs = sentControlMessages.filter((m) => m.type === 'config' && m.language === 'es-ES');
    assert.equal(esConfigs.length, 1);
    assert.equal(getActiveVoiceSessions()[0].language, 'es-ES');
    assert.equal(hookApi.selectedLanguage, 'es-ES');
    assert.equal(getDisplayedPillCode(), 'ES');
    assert.equal(dom.localStorage.getItem('orvix_dictation_lang'), 'es-ES');

    // Clicking 'es-ES' again must not send another config message
    await act(async () => {
      hookApi.setSelectedLanguage('es-ES');
    });
    assert.equal(sentControlMessages.filter((m) => m.type === 'config').length, 1);

    // 3. Attempting an invalid language update while WS is open gets rejected by server and reconciles UI back to 'es-ES'
    await act(async () => {
      hookApi.setSelectedLanguage('xx-INVALID');
      await new Promise((r) => setTimeout(r, 80));
    });

    assert.equal(getActiveVoiceSessions()[0].language, 'es-ES');
    assert.equal(hookApi.selectedLanguage, 'es-ES');
    assert.equal(getDisplayedPillCode(), 'ES');
    assert.equal(dom.localStorage.getItem('orvix_dictation_lang'), 'es-ES');
    assert.ok(hookApi.dictationError, 'Invalid language error should surface cleanly');
    assert.equal(hookApi.recordingState, 'listening', 'Invalid language rejection must keep active session alive');

    // 4. Disconnected WebSocket session: force-close server socket, then change language safely without throwing
    const activeSession = getActiveVoiceSessions()[0];
    await act(async () => {
      activeSession.ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    await act(async () => {
      hookApi.setSelectedLanguage('de-DE');
      hookApi.setSelectedLanguage('invalid-while-disconnected');
    });
    assert.equal(hookApi.selectedLanguage, 'de-DE');
    assert.equal(getDisplayedPillCode(), 'DE');

    await act(async () => {
      hookApi.cancelListening();
      await new Promise((r) => setTimeout(r, 400));
    });
  } finally {
    await act(async () => {
      root?.unmount();
    });
    dom.cleanup();
    setAuthInstanceForTesting(null);
    globalThis.fetch = origFetch;
    if (prevGroq !== undefined) process.env.GROQ_API_KEY = prevGroq;
    else delete process.env.GROQ_API_KEY;
    resetVoiceWebSocketStateForTesting();
    resetFirebaseAuthForTesting();
    resetRateLimitersForTesting();
    await srv.close();
  }
});

test('ORVIX-LOW-04 fallback: Web Speech API fallback restarts recognition with updated language and emits no WS messages', async () => {
  const recognitionInstances: any[] = [];
  class MockSpeechRecognition {
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    lang = 'en-US';
    onstart: any = null;
    onresult: any = null;
    onerror: any = null;
    onend: any = null;
    aborted = false;
    stopped = false;

    constructor() {
      recognitionInstances.push(this);
    }
    start() {
      setTimeout(() => {
        this.onstart?.();
      }, 5);
    }
    stop() {
      this.stopped = true;
      setTimeout(() => {
        this.onend?.();
      }, 5);
    }
    abort() {
      this.aborted = true;
    }
  }

  let wsConstructedCount = 0;
  class NoWsAllowed {
    constructor() {
      wsConstructedCount += 1;
      throw new Error('WebSocket should not be opened when WebSocket streaming is disabled');
    }
  }

  const dom = installDictationDom({
    localStorage: createMemoryStorage({ orvix_dictation_lang: 'en-US' }),
    SpeechRecognition: MockSpeechRecognition,
    WebSocketImpl: NoWsAllowed
  });

  let hookApi: any = null;
  let root: Root | null = null;

  function FallbackHarness() {
    hookApi = (useVoiceDictation as any)({
      inputValue: '',
      onInputChange: () => {},
      enableWebSocketStreaming: false
    });
    return null;
  }

  try {
    const container = dom.doc.createElement('div');
    dom.doc.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(FallbackHarness));
    });

    await act(async () => {
      await hookApi.startListening();
      await new Promise((r) => setTimeout(r, 25));
    });

    assert.equal(hookApi.recordingState, 'listening');
    assert.equal(hookApi.isStreamingWebSocket, false);
    assert.equal(recognitionInstances.length, 1);
    assert.equal(recognitionInstances[0].lang, 'en-US');

    // Switching language while listening in Web Speech fallback restarts SpeechRecognition with new lang
    await act(async () => {
      hookApi.setSelectedLanguage('fr-FR');
      await new Promise((r) => setTimeout(r, 25));
    });

    assert.equal(hookApi.selectedLanguage, 'fr-FR');
    assert.equal(recognitionInstances.length, 2);
    assert.equal(recognitionInstances[0].aborted, true);
    assert.equal(recognitionInstances[1].lang, 'fr-FR');
    assert.equal(wsConstructedCount, 0);

    // Calling setSelectedLanguage with unchanged language does NOT trigger extra restarts
    await act(async () => {
      hookApi.setSelectedLanguage('fr-FR');
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.equal(recognitionInstances.length, 2);

    await act(async () => {
      hookApi.cancelListening();
      await new Promise((r) => setTimeout(r, 400));
    });
  } finally {
    await act(async () => {
      root?.unmount();
    });
    dom.cleanup();
  }
});

test('ORVIX-LOW-04 client: VoiceStreamClient.updateConfig returns false cleanly when disconnected or unchanged', async () => {
  const client = new VoiceStreamClient({ url: 'wss://example.test/api/voice-stream', language: 'en-US' });
  assert.equal(client.isConnected(), false);
  assert.equal(client.updateConfig({ language: 'es-ES' }), false);

  const sent: string[] = [];
  client.state = 'listening';
  client.ws = {
    readyState: 1,
    send(msg: string) {
      sent.push(msg);
    }
  } as any;

  // Same language -> skipped
  assert.equal(client.updateConfig({ language: 'en-US' }), false);
  assert.equal(sent.length, 0);

  // New language -> sends config frame once
  assert.equal(client.updateConfig({ language: 'es-ES' }), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]), { type: 'config', language: 'es-ES' });

  // Duplicate while pending -> skipped
  assert.equal(client.updateConfig({ language: 'es-ES' }), false);
  assert.equal(sent.length, 1);
});
