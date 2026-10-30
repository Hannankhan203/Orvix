#!/usr/bin/env node

/**
 * Audit Point #11 — Real Browser WebGPU `shader-f16` Fallback Verification Suite
 *
 * Launches a real headless Chromium browser via the Chrome DevTools Protocol (CDP)
 * against a live ephemeral Vite instance serving the actual Orvix AI React application
 * (`index.html` -> `App.jsx` -> `ChatPage.jsx` -> `ModelSelector.jsx` -> `ChatArea.jsx`
 * -> `BrowserAIStatusBar.jsx` -> `webllmService.js` -> `webllmWorker.js`).
 *
 * Strict Test Honesty Policy:
 * - Section 1 runs against Chromium's REAL, UNMOCKED `navigator.gpu` (`GPU` / `GPUAdapter`
 *   / `GPUDevice`) with zero monkey-patching of `navigator.gpu` or `GPUAdapter`.
 * - Any scenario whose hardware precondition is not satisfied by the host's real WebGPU
 *   adapter (for example, Scenario A when the host only has a `shader-f16`-unsupported
 *   adapter such as Dawn/SwiftShader, or Scenario B when run on a physical `shader-f16`
 *   GPU without SwiftShader) is explicitly recorded as `SKIPPED` and NEVER counted as `PASSED`.
 * - Section 2 runs clearly separated, explicitly labeled controlled feature-override
 *   browser checks in an isolated page solely to regression-test application branching
 *   that the host's single adapter variant does not natively exercise.
 * - Avoids downloading ~1 GB Hugging Face weights by intercepting engine weight loading
 *   after real `navigator.gpu.requestAdapter()`, real `@mlc-ai/web-llm` catalog validation,
 *   real browser `CacheStorage` / `navigator.storage` checks, and real ES module `Worker`
 *   (`orvix-webllm-worker`) creation have executed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// ============================================================================
// Browser Discovery & Minimal CDP Driver
// ============================================================================

function findChromiumBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // Continue checking candidates
    }
  }

  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
      if (resolved && fs.existsSync(resolved)) {
        return resolved;
      }
    } catch (_) {
      // Ignore missing binary
    }
  }

  return null;
}

class CDPPageSession {
  constructor(ws, browserProcess, baseHttpUrl, targetId) {
    this.ws = ws;
    this.browserProcess = browserProcess;
    this.baseHttpUrl = baseHttpUrl;
    this.targetId = targetId;
    this.seq = 0;
    this.pending = new Map();
    this.eventListeners = new Map();

    this.ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch (_) {
        return;
      }
      if (typeof payload.id === 'number') {
        const entry = this.pending.get(payload.id);
        if (entry) {
          this.pending.delete(payload.id);
          if (payload.error) {
            entry.reject(
              new Error(`CDP ${entry.method} error: ${payload.error.message || JSON.stringify(payload.error)}`)
            );
          } else {
            entry.resolve(payload.result);
          }
        }
        return;
      }
      if (payload.method) {
        const listeners = this.eventListeners.get(payload.method);
        if (listeners) {
          for (const listener of [...listeners]) {
            try {
              listener(payload.params);
            } catch (_) {
              // Ignore listener exception
            }
          }
        }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 20_000);

      this.pending.set(id, {
        method,
        resolve: (res) => {
          clearTimeout(timeout);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(eventMethod, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event ${eventMethod}`));
      }, timeoutMs);

      const handler = (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      };

      const off = () => {
        const set = this.eventListeners.get(eventMethod);
        if (set) {
          set.delete(handler);
        }
      };

      if (!this.eventListeners.has(eventMethod)) {
        this.eventListeners.set(eventMethod, new Set());
      }
      this.eventListeners.get(eventMethod).add(handler);
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response?.exceptionDetails) {
      const desc =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'Browser evaluation exception';
      throw new Error(desc);
    }
    return response?.result?.value;
  }

  async navigate(url) {
    const loadFired = this.once('Page.loadEventFired', 20_000);
    await this.send('Page.navigate', { url });
    await loadFired;
  }

  async close() {
    try {
      this.ws.close();
    } catch (_) {
      // Ignore close error
    }
    if (this.targetId && this.baseHttpUrl) {
      try {
        await fetch(`${this.baseHttpUrl}/json/close/${this.targetId}`);
      } catch (_) {
        // Ignore target close error
      }
    }
  }
}

async function launchChromiumBrowser(chromeBin, { useNativeGpuOnly = false } = {}) {
  const gpuFlags = useNativeGpuOnly
    ? ['--enable-unsafe-webgpu']
    : [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
        '--use-webgpu-adapter=swiftshader'
      ];

  const args = [
    '--headless',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    ...gpuFlags,
    'about:blank'
  ];

  const proc = spawn(chromeBin, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const devtoolsWsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Timed out waiting for Chromium DevTools WebSocket endpoint'));
    }, 10_000);

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited prematurely (code=${code}): ${stderrBuf.slice(-400)}`));
    });
  });

  const baseHttpUrl = devtoolsWsUrl.replace('ws://', 'http://').split('/devtools/')[0];

  async function newPage({ initScripts = [] } = {}) {
    const createRes = await fetch(`${baseHttpUrl}/json/new?about:blank`, {
      method: 'PUT'
    }).then((r) => r.json());

    const ws = new WebSocket(createRes.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const session = new CDPPageSession(ws, proc, baseHttpUrl, createRes.id);
    await session.send('Page.enable');
    await session.send('Runtime.enable');

    for (const source of initScripts) {
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source });
    }

    return session;
  }

  async function shutdown() {
    try {
      proc.kill('SIGKILL');
    } catch (_) {
      // Ignore
    }
  }

  return { proc, baseHttpUrl, newPage, shutdown };
}

async function startEphemeralOrvixServer() {
  const vite = await createViteServer({
    root: ROOT_DIR,
    appType: 'spa',
    logLevel: 'error',
    server: {
      host: true,
      port: 39173,
      strictPort: false,
      hmr: false
    },
    plugins: [
      {
        name: 'orvix-ephemeral-api-config',
        configureServer(server) {
          server.middlewares.use('/api/config', (_req, res) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                geminiConfigured: true,
                groqConfigured: true,
                openrouterConfigured: true,
                cloudflareConfigured: true,
                webllmSupported: true,
                demoModeEnabled: false,
                whisperConfigured: false,
                whisperProvider: null
              })
            );
          });
        }
      }
    ]
  });

  await vite.listen();
  const address = vite.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) {
    await vite.close();
    throw new Error('Failed to bind ephemeral Vite HTTP server');
  }

  return {
    vite,
    origin: `http://127.0.0.1:${port}`
  };
}

// ============================================================================
// Guest Session Bootstrap & Reusable Browser Helpers
// ============================================================================

const GUEST_BOOTSTRAP_SCRIPT = `
  try {
    const guestPayload = JSON.stringify({
      uid: 'guest-webgpu-fallback-test',
      isAnonymous: true,
      username: 'WebGPU Tester',
      displayName: 'WebGPU Tester',
      email: 'guest@orvix.ai'
    });
    localStorage.setItem('orvix_guest_session', guestPayload);
    sessionStorage.setItem('orvix_guest_session', guestPayload);
    localStorage.removeItem('orvix_selected_provider');
    localStorage.removeItem('orvix_webllm_model_id');
  } catch (_) {}

  // Track spawned Web Workers and Worker.prototype.terminate invocations non-invasively
  // while preserving the real native browser Worker constructor & execution.
  (() => {
    const NativeWorker = window.Worker;
    const records = [];
    window.__orvixWorkerRecords = records;

    class TrackedNativeWorker extends NativeWorker {
      constructor(scriptURL, options) {
        super(scriptURL, options);
        const rec = {
          name: options?.name || '',
          scriptURL: String(scriptURL),
          terminated: false,
          createdAt: performance.now()
        };
        this.__orvixRecord = rec;
        records.push(rec);
      }

      terminate() {
        if (this.__orvixRecord) {
          this.__orvixRecord.terminated = true;
          this.__orvixRecord.terminatedAt = performance.now();
        }
        return super.terminate();
      }
    }

    window.Worker = TrackedNativeWorker;

    window.__setReactSelectValue = (selector, nextValue) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('Missing select element: ' + selector);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(el, nextValue);
      } else {
        el.value = nextValue;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el;
    };
  })();
`;

async function waitForChatReady(page, origin) {
  await page.navigate(`${origin}/`);
  const deadline = Date.now() + 25_000;
  let lastDiag = '';
  while (Date.now() < deadline) {
    try {
      const check = await page.evaluate(`(() => {
        const sel = document.querySelector('#ai-model-select-desktop') || document.querySelector('.model-selector-select');
        const footnote = document.querySelector('.composer-footnote');
        if (sel && footnote) {
          return { ready: true };
        }
        const guestBtn = Array.from(document.querySelectorAll('button')).find((b) =>
          /guest/i.test(b.textContent || '')
        );
        if (guestBtn) {
          guestBtn.click();
        }
        return {
          ready: false,
          url: location.href,
          title: document.title,
          bodySnippet: (document.body?.innerText || '').slice(0, 160)
        };
      })()`);
      if (check?.ready) {
        return;
      }
      lastDiag = JSON.stringify(check);
    } catch (err) {
      // Execution context can briefly reset if Vite finishes initial dependency pre-bundling
      lastDiag = String(err?.message || err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for Orvix ChatPage (#ai-model-select-desktop) to mount; lastDiag=${lastDiag}`);
}

// ============================================================================
// Result Tracking (PASSED / FAILED / SKIPPED — Never Conflated)
// ============================================================================

const results = {
  passed: [],
  skipped: [],
  failed: []
};

async function runCase(name, category, fn) {
  try {
    const outcome = await fn();
    if (outcome && outcome.skipped) {
      results.skipped.push({ name, category, reason: outcome.reason });
      console.log(`  ⏭️  SKIPPED [${category}]: ${name}`);
      console.log(`      Reason: ${outcome.reason}`);
      return;
    }
    results.passed.push({ name, category, detail: outcome?.detail || null });
    console.log(`  ✅ PASSED  [${category}]: ${name}`);
    if (outcome?.detail) {
      console.log(`      ${outcome.detail}`);
    }
  } catch (err) {
    results.failed.push({ name, category, error: err });
    console.error(`  ❌ FAILED  [${category}]: ${name}`);
    console.error(`      ${err?.stack || err?.message || err}`);
  }
}

// ============================================================================
// Main Execution
// ============================================================================

console.log('========================================================================');
console.log('🧪 Orvix AI — Real Browser WebGPU shader-f16 Fallback Verification Suite');
console.log('========================================================================\n');

const chromeBin = findChromiumBinary();
if (!chromeBin) {
  console.log('⏭️  SKIPPED: No Chromium/Chrome binary found in this environment.');
  console.log('    Set CHROME_BIN=/path/to/chrome to execute real-browser WebGPU tests.\n');
  process.exit(0);
}

const useNativeGpuOnly = process.env.ORVIX_TEST_NATIVE_GPU === '1';
let serverHandle = null;
let browserHandle = null;

try {
  serverHandle = await startEphemeralOrvixServer();
  browserHandle = await launchChromiumBrowser(chromeBin, { useNativeGpuOnly });

  // --------------------------------------------------------------------------
  // SECTION 1: REAL UNMOCKED BROWSER WEBGPU ADAPTER SUITE
  // (`navigator.gpu` and `GPUAdapter` are 100% genuine, untouched Chromium Dawn objects)
  // --------------------------------------------------------------------------
  console.log('--- Section 1: Real Unmocked Browser WebGPU Adapter Suite (Zero navigator.gpu Mocks) ---');

  const realPage = await browserHandle.newPage({
    initScripts: [GUEST_BOOTSTRAP_SCRIPT]
  });

  await waitForChatReady(realPage, serverHandle.origin);

  const realGpuProbe = await realPage.evaluate(`(async () => {
    const hasGpuObject = 'gpu' in navigator && Boolean(navigator.gpu);
    if (!hasGpuObject) {
      return {
        ua: navigator.userAgent,
        isSecureContext: window.isSecureContext,
        hasGpuObject: false,
        adapterAvailable: false
      };
    }

    const gpuProtoName = Object.prototype.toString.call(navigator.gpu);
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return {
        ua: navigator.userAgent,
        isSecureContext: window.isSecureContext,
        hasGpuObject: true,
        gpuProtoName,
        adapterAvailable: false
      };
    }

    // Also probe WebGPU inside a real dedicated Web Worker to confirm worker-thread parity
    const workerBlob = new Blob([
      \`self.onmessage = async () => {
        try {
          const a = await self.navigator.gpu.requestAdapter();
          if (!a) { self.postMessage({ ok: false }); return; }
          self.postMessage({
            ok: true,
            hasShaderF16: a.features.has('shader-f16'),
            vendor: a.info?.vendor || '',
            architecture: a.info?.architecture || ''
          });
        } catch (e) {
          self.postMessage({ ok: false, error: e.message });
        }
      };\`
    ], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);
    const probeWorker = new Worker(workerUrl);
    const workerGpu = await new Promise((resolve) => {
      probeWorker.onmessage = (ev) => resolve(ev.data);
      probeWorker.onerror = (ev) => resolve({ ok: false, error: ev.message });
      probeWorker.postMessage('probe');
    });
    probeWorker.terminate();
    URL.revokeObjectURL(workerUrl);

    return {
      ua: navigator.userAgent,
      isSecureContext: window.isSecureContext,
      hasGpuObject: true,
      gpuProtoName,
      isNativeGPUInstance: typeof GPU !== 'undefined' && navigator.gpu instanceof GPU,
      isNativeAdapterInstance: typeof GPUAdapter !== 'undefined' && adapter instanceof GPUAdapter,
      adapterAvailable: true,
      hasShaderF16: adapter.features.has('shader-f16'),
      features: Array.from(adapter.features),
      isFallbackAdapter: Boolean(adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter),
      info: adapter.info
        ? {
            vendor: adapter.info.vendor || '',
            architecture: adapter.info.architecture || '',
            device: adapter.info.device || '',
            description: adapter.info.description || ''
          }
        : null,
      workerGpu
    };
  })()`);

  console.log(`  Browser UA        : ${realGpuProbe.ua}`);
  console.log(`  Secure Context    : ${realGpuProbe.isSecureContext}`);
  console.log(`  Real GPUAdapter   : ${realGpuProbe.adapterAvailable} (instanceof GPUAdapter=${Boolean(realGpuProbe.isNativeAdapterInstance)})`);
  if (realGpuProbe.adapterAvailable) {
    console.log(
      `  Adapter Info      : vendor="${realGpuProbe.info?.vendor}" arch="${realGpuProbe.info?.architecture}" fallback=${realGpuProbe.isFallbackAdapter}`
    );
    console.log(
      `  Real shader-f16   : mainThread=${realGpuProbe.hasShaderF16}, webWorker=${realGpuProbe.workerGpu?.hasShaderF16} (${realGpuProbe.features.length} features)`
    );
  }
  console.log('');

  // Scenario A (Real Unmocked Browser Adapter)
  await runCase(
    'Scenario A — Real browser adapter WITH shader-f16 selects FP16 (q4f16_1) and does not switch to FP32',
    'REAL-ADAPTER',
    async () => {
      if (!realGpuProbe.adapterAvailable) {
        return {
          skipped: true,
          reason: 'Browser returned null from real navigator.gpu.requestAdapter() in this environment.'
        };
      }
      if (!realGpuProbe.hasShaderF16) {
        return {
          skipped: true,
          reason: `Host's real unmocked Dawn GPUAdapter (${realGpuProbe.info?.vendor || 'unknown'}/${realGpuProbe.info?.architecture || 'unknown'}) natively has shader-f16=false; real hardware shader-f16 cannot be claimed without a physical shader-f16 GPU (run with ORVIX_TEST_NATIVE_GPU=1 on shader-f16 hardware).`
        };
      }

      const check = await realPage.evaluate(`(async () => {
        const svc = await import('/src/services/webllmService.js');
        svc.resetWebLLMRuntimeForTesting();
        let initializedModelId = null;
        svc.setWebLLMEngineFactoryForTesting(async ({ worker, modelId, handleInitProgress }) => {
          initializedModelId = modelId;
          handleInitProgress({ progress: 1, text: 'Finish loading' });
          return {
            forwardTokensAndSample: async () => 1,
            resetChat: async () => {},
            interruptGenerate: () => {},
            unload: async () => {},
            chat: { completions: { create: async () => (async function* () { yield { choices: [{ delta: { content: 'OK' } }] }; })() } }
          };
        });

        window.__setReactSelectValue('#ai-model-select-desktop', 'webllm');

        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const st = svc.getWebLLMState();
          if (st.hasShaderF16 === true) break;
          await new Promise((r) => setTimeout(r, 30));
        }

        const loadBtn = Array.from(document.querySelectorAll('.browser-ai-action-btn')).find((b) =>
          /Load Model|Download & Load/.test(b.textContent || '')
        );
        loadBtn.click();

        while (Date.now() < deadline) {
          if (svc.getWebLLMState().status === 'ready') break;
          await new Promise((r) => setTimeout(r, 30));
        }

        return {
          initializedModelId,
          state: svc.getWebLLMState(),
          headline: document.querySelector('.browser-ai-headline')?.textContent || '',
          footnote: document.querySelector('.composer-footnote')?.textContent || ''
        };
      })()`);

      assert.strictEqual(check.initializedModelId, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
      assert.strictEqual(check.state.loadedModelId, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
      assert.strictEqual(check.state.hasShaderF16, true);
      assert.ok(!check.initializedModelId.includes('q4f32_1'));
      assert.ok(check.headline.includes('Qwen 2.5 1.5B — Ready on device'));
      assert.ok(!check.headline.includes('(FP32)'));
      return {
        detail: `Verified real shader-f16 adapter selected ${check.initializedModelId}`
      };
    }
  );

  // Scenario B (Real Unmocked Browser Adapter WITHOUT shader-f16)
  await runCase(
    'Scenario B — Real browser adapter WITHOUT shader-f16 selects FP32 fallback across all 4 tiers without loading FP16 or entering error/loading state',
    'REAL-ADAPTER',
    async () => {
      if (!realGpuProbe.adapterAvailable) {
        return {
          skipped: true,
          reason: 'Browser returned null from real navigator.gpu.requestAdapter() in this environment.'
        };
      }
      if (realGpuProbe.hasShaderF16) {
        return {
          skipped: true,
          reason: 'Real adapter natively supports shader-f16; re-run without ORVIX_TEST_NATIVE_GPU=1 to exercise real Dawn/SwiftShader adapter lacking shader-f16.'
        };
      }

      const result = await realPage.evaluate(`(async () => {
        const svc = await import('/src/services/webllmService.js');
        svc.resetWebLLMRuntimeForTesting();
        window.__orvixWorkerRecords.length = 0;

        // Verify navigator.gpu is still the unmocked native Chromium GPU instance
        const nativeGpuIntact =
          typeof GPU !== 'undefined' &&
          navigator.gpu instanceof GPU &&
          !Object.prototype.hasOwnProperty.call(navigator, 'gpu');

        // Switch active provider to Browser AI (WebLLM) through the real ModelSelector <select>
        window.__setReactSelectValue('#ai-model-select-desktop', 'webllm');

        // Wait for ChatPage's real inspectWebLLMReadiness() effect to complete
        const waitReadiness = async (expectedResolvedModelId) => {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            const st = svc.getWebLLMState();
            const badge = document.querySelector('.browser-ai-status-badge')?.textContent?.trim() || '';
            if (
              st.hasShaderF16 === false &&
              st.modelId === expectedResolvedModelId &&
              st.status === 'idle' &&
              badge !== 'Checking GPU'
            ) {
              return st;
            }
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error(
            'Timed out waiting for readiness state for ' +
              expectedResolvedModelId +
              '; current=' +
              JSON.stringify(svc.getWebLLMState())
          );
        };

        const defaultReadiness = await waitReadiness('Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
        const defaultHeadline = document.querySelector('.browser-ai-headline')?.textContent?.trim() || '';
        const defaultBadge = document.querySelector('.browser-ai-status-badge')?.textContent?.trim() || '';
        const defaultFootnote = document.querySelector('.composer-footnote')?.textContent?.trim() || '';

        // Cycle through all 4 Browser AI models in the real BrowserAIStatusBar <select>
        const tierPairs = [
          ['SmolLM2-135M-Instruct-q0f16-MLC', 'SmolLM2-135M-Instruct-q0f32-MLC', 'SmolLM2 135M (FP32)'],
          ['SmolLM2-360M-Instruct-q4f16_1-MLC', 'SmolLM2-360M-Instruct-q4f32_1-MLC', 'SmolLM2 360M (FP32)'],
          ['Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC', 'Qwen3 0.6B (FP32)'],
          ['Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', 'Qwen 2.5 1.5B (FP32)']
        ];

        const tierResults = [];
        for (const [fp16Id, expectedFp32Id, expectedShortLabel] of tierPairs) {
          const modelSelect = window.__setReactSelectValue('.browser-ai-model-select', fp16Id);
          const st = await waitReadiness(expectedFp32Id);
          tierResults.push({
            selectedOptionValue: modelSelect.value,
            resolvedStateModelId: st.modelId,
            loadedModelId: st.loadedModelId,
            status: st.status,
            error: st.error,
            headline: document.querySelector('.browser-ai-headline')?.textContent?.trim() || '',
            footnote: document.querySelector('.composer-footnote')?.textContent?.trim() || '',
            expectedFp32Id,
            expectedShortLabel
          });
        }

        return {
          nativeGpuIntact,
          defaultReadiness,
          defaultHeadline,
          defaultBadge,
          defaultFootnote,
          tierResults,
          workersSpawnedDuringReadiness: window.__orvixWorkerRecords.length
        };
      })()`);

      assert.strictEqual(result.nativeGpuIntact, true, 'navigator.gpu must remain native and unmocked');
      assert.strictEqual(result.defaultReadiness.hasShaderF16, false);
      assert.strictEqual(result.defaultReadiness.modelId, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.strictEqual(result.defaultReadiness.loadedModelId, null);
      assert.strictEqual(result.defaultReadiness.status, 'idle');
      assert.strictEqual(result.defaultReadiness.error, null);
      assert.strictEqual(result.defaultHeadline, 'Qwen 2.5 1.5B (FP32) — Browser AI');
      assert.ok(
        result.defaultBadge === 'Not Downloaded' || result.defaultBadge === 'Cached',
        `Unexpected badge after readiness check: ${result.defaultBadge}`
      );
      assert.ok(result.defaultFootnote.includes('Qwen 2.5 1.5B (FP32)'));
      assert.strictEqual(
        result.workersSpawnedDuringReadiness,
        0,
        'Readiness check must not eagerly spawn workers or load FP16 models'
      );

      for (const tier of result.tierResults) {
        assert.strictEqual(tier.resolvedStateModelId, tier.expectedFp32Id);
        assert.strictEqual(tier.status, 'idle');
        assert.strictEqual(tier.error, null);
        assert.strictEqual(tier.loadedModelId, null);
        assert.ok(tier.headline.includes(tier.expectedShortLabel));
        assert.ok(tier.footnote.includes(tier.expectedShortLabel));
      }

      return {
        detail:
          'All 4 FP16 Browser AI tiers mapped cleanly to q0f32 / q4f32_1 on real Dawn/SwiftShader adapter with status="idle", error=null, and 0 FP16 loads.'
      };
    }
  );

  // Scenario C (Real Unmocked Browser Fallback Initialization, Worker/Engine/UI Consistency & Real Compute Pass)
  await runCase(
    'Scenario C — Real browser FP32 fallback initializes dedicated Web Worker + engine to ready, keeps UI/selector/worker/service consistent, and streams chat response',
    'REAL-ADAPTER',
    async () => {
      if (!realGpuProbe.adapterAvailable || realGpuProbe.hasShaderF16) {
        return {
          skipped: true,
          reason: 'Requires real browser WebGPU adapter without shader-f16.'
        };
      }

      const result = await realPage.evaluate(`(async () => {
        const svc = await import('/src/services/webllmService.js');
        window.__orvixWorkerRecords.length = 0;

        // Also verify real Dawn GPUDevice rejects f16 WGSL and executes a real f32 compute shader!
        const realAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        let f16RequestDeviceRejected = false;
        try {
          await realAdapter.requestDevice({ requiredFeatures: ['shader-f16'] });
        } catch (_) {
          f16RequestDeviceRejected = true;
        }

        const realDevice = await realAdapter.requestDevice();
        realDevice.pushErrorScope('validation');
        realDevice.createShaderModule({
          code: 'enable f16;\\n@compute @workgroup_size(1) fn main() {}'
        });
        const f16ShaderError = await realDevice.popErrorScope();

        // Execute a real FP32 compute pass on the real Dawn GPUDevice
        const f32Module = realDevice.createShaderModule({
          code: \`
            @group(0) @binding(0) var<storage, read_write> data: array<f32>;
            @compute @workgroup_size(4)
            fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
              data[gid.x] = data[gid.x] * 2.5;
            }
          \`
        });
        const f32Pipeline = await realDevice.createComputePipelineAsync({
          layout: 'auto',
          compute: { module: f32Module, entryPoint: 'main' }
        });
        const inputFloats = new Float32Array([1, 2, 3, 4]);
        const storageBuf = realDevice.createBuffer({
          size: inputFloats.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        });
        const readbackBuf = realDevice.createBuffer({
          size: inputFloats.byteLength,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        realDevice.queue.writeBuffer(storageBuf, 0, inputFloats);
        const bindGroup = realDevice.createBindGroup({
          layout: f32Pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: storageBuf } }]
        });
        const encoder = realDevice.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(f32Pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(storageBuf, 0, readbackBuf, 0, inputFloats.byteLength);
        realDevice.queue.submit([encoder.finish()]);
        await readbackBuf.mapAsync(GPUMapMode.READ);
        const f32ComputeOutput = Array.from(new Float32Array(readbackBuf.getMappedRange()));
        readbackBuf.unmap();
        storageBuf.destroy();
        readbackBuf.destroy();
        realDevice.destroy();

        // Intercept ONLY the ~1.1 GB Hugging Face weight download inside customEngineFactory
        // while keeping navigator.gpu, @mlc-ai/web-llm prebuiltAppConfig check, CacheStorage check,
        // and the real dedicated ES module Web Worker (orvix-webllm-worker) 100% genuine!
        const engineInitCalls = [];
        const observedStatuses = [];
        const unsub = svc.subscribeWebLLMState((st) => {
          observedStatuses.push({
            status: st.status,
            modelId: st.modelId,
            loadedModelId: st.loadedModelId
          });
        });

        svc.setWebLLMEngineFactoryForTesting(async ({ worker, modelId, handleInitProgress, chatOpts }) => {
          engineInitCalls.push({
            modelId,
            isRealWorker: worker instanceof Worker,
            contextWindowSize: chatOpts?.context_window_size
          });
          handleInitProgress({ progress: 0.35, text: 'Fetching param cache [12/34]', timeElapsed: 1 });
          await new Promise((r) => setTimeout(r, 20));
          handleInitProgress({ progress: 1.0, text: 'Loading GPU shader modules (FP32)', timeElapsed: 2 });
          await new Promise((r) => setTimeout(r, 20));
          return {
            forwardTokensAndSample: async () => 1,
            resetChat: async () => {},
            interruptGenerate: () => {},
            unload: async () => {},
            chat: {
              completions: {
                create: async () =>
                  (async function* () {
                    yield { choices: [{ delta: { content: 'FP32 ' } }] };
                    yield { choices: [{ delta: { content: 'fallback ' } }] };
                    yield {
                      choices: [{ delta: { content: 'verified in real browser.' } }],
                      usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 }
                    };
                  })()
              }
            }
          };
        });

        // Click the real "Download & Load" / "Load Model" button in BrowserAIStatusBar
        const loadBtn = Array.from(document.querySelectorAll('.browser-ai-action-btn')).find((b) =>
          /Download & Load|Load Model/.test(b.textContent || '')
        );
        if (!loadBtn) {
          throw new Error('Could not locate Download & Load button in BrowserAIStatusBar');
        }
        loadBtn.click();

        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const st = svc.getWebLLMState();
          const badge = document.querySelector('.browser-ai-status-badge')?.textContent?.trim();
          if (st.status === 'ready' && badge === 'Ready') break;
          await new Promise((r) => setTimeout(r, 25));
        }

        unsub();

        const readyState = svc.getWebLLMState();
        const readyHeadline = document.querySelector('.browser-ai-headline')?.textContent?.trim() || '';
        const readyBadge = document.querySelector('.browser-ai-status-badge')?.textContent?.trim() || '';
        const readyFootnote = document.querySelector('.composer-footnote')?.textContent?.trim() || '';
        const providerSelectValue = document.querySelector('#ai-model-select-desktop')?.value || '';
        const modelSelectValue = document.querySelector('.browser-ai-model-select')?.value || '';
        const hasUnloadBtn = Array.from(document.querySelectorAll('.browser-ai-action-btn')).some((b) =>
          (b.textContent || '').includes('Unload')
        );

        // Now send a real chat prompt through the live Orvix UI composer to confirm
        // zero-IPC reuse of the FP32 engine and consistent message metadata!
        const textarea = document.querySelector('form.composer-form textarea');
        const nativeValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        ).set;
        nativeValueSetter.call(textarea, 'Verify FP32 WebGPU fallback generation');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        await new Promise((r) => setTimeout(r, 30));
        const form = document.querySelector('form.composer-form');
        form.requestSubmit();

        while (Date.now() < deadline) {
          const assistantText = document.body.innerText || '';
          const badges = Array.from(document.querySelectorAll('.assistant-wrapper .model-badge'));
          if (
            assistantText.includes('FP32 fallback verified in real browser.') &&
            badges.length > 0 &&
            svc.getWebLLMState().status === 'ready' &&
            !document.querySelector('.composer-stop-btn')
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 30));
        }

        const latestBadgeEl = Array.from(document.querySelectorAll('.assistant-wrapper .model-badge')).pop();
        const latestBadgeText = latestBadgeEl?.textContent?.trim() || '';
        const latestBadgeTitle = latestBadgeEl?.getAttribute('title') || '';

        return {
          f16RequestDeviceRejected,
          f16ShaderErrorMsg: f16ShaderError ? f16ShaderError.message : null,
          f32ComputeOutput,
          engineInitCalls,
          observedStatuses,
          workerRecords: window.__orvixWorkerRecords.map((w) => ({ ...w })),
          readyState,
          readyHeadline,
          readyBadge,
          readyFootnote,
          providerSelectValue,
          modelSelectValue,
          hasUnloadBtn,
          latestBadgeText,
          latestBadgeTitle
        };
      })()`);

      assert.strictEqual(result.f16RequestDeviceRejected, true, 'Real Dawn GPUAdapter must reject shader-f16 device request');
      assert.ok(
        result.f16ShaderErrorMsg && result.f16ShaderErrorMsg.includes("extension 'f16'"),
        `Expected real Dawn WGSL f16 validation error, got: ${result.f16ShaderErrorMsg}`
      );
      assert.deepStrictEqual(result.f32ComputeOutput, [2.5, 5, 7.5, 10]);

      // Verify FP16 was NEVER initialized and FP32 was initialized exactly once (reused for chat prompt!)
      assert.strictEqual(result.engineInitCalls.length, 1);
      assert.strictEqual(result.engineInitCalls[0].modelId, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.strictEqual(result.engineInitCalls[0].isRealWorker, true);

      // Verify real dedicated ES module worker was spawned and kept alive in ready state
      assert.strictEqual(result.workerRecords.length, 1);
      assert.strictEqual(result.workerRecords[0].name, 'orvix-webllm-worker');
      assert.ok(result.workerRecords[0].scriptURL.includes('webllmWorker.js'));
      assert.strictEqual(result.workerRecords[0].terminated, false);

      // Verify state & UI consistency across ModelSelector, BrowserAIStatusBar, footnote, worker, and rendered ChatMessage badge
      assert.strictEqual(result.providerSelectValue, 'webllm');
      assert.strictEqual(result.modelSelectValue, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
      assert.strictEqual(result.readyState.status, 'ready');
      assert.strictEqual(result.readyState.modelId, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.strictEqual(result.readyState.loadedModelId, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.strictEqual(result.readyState.hasShaderF16, false);
      assert.strictEqual(result.readyState.error, null);
      assert.strictEqual(result.readyHeadline, 'Qwen 2.5 1.5B (FP32) — Ready on device');
      assert.strictEqual(result.readyBadge, 'Ready');
      assert.strictEqual(result.hasUnloadBtn, true);
      assert.ok(result.readyFootnote.includes('Qwen 2.5 1.5B (FP32)'));
      assert.strictEqual(result.latestBadgeText, 'Browser AI: Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.ok(result.latestBadgeTitle.includes('Provider: webllm'));
      assert.ok(result.latestBadgeTitle.includes('Model: Qwen2.5-1.5B-Instruct-q4f32_1-MLC'));

      const anyFp16Loaded = result.observedStatuses.some(
        (s) => s.loadedModelId && s.loadedModelId.includes('q4f16_1')
      );
      assert.strictEqual(anyFp16Loaded, false, 'FP16 model must never be marked loaded');

      return {
        detail:
          'Real Dawn f32 compute verified ([2.5,5,7.5,10]), real orvix-webllm-worker spawned once with Qwen2.5-1.5B-Instruct-q4f32_1-MLC, UI/selector/footnote/message metadata all consistent.'
      };
    }
  );

  // Scenario D (Real Unmocked Browser — Failure Handling When FP32 Initialization Also Fails)
  await runCase(
    'Scenario D — Real browser FP32 initialization failure displays error, never marks ready, terminates worker, and cleans up loading state',
    'REAL-ADAPTER',
    async () => {
      if (!realGpuProbe.adapterAvailable || realGpuProbe.hasShaderF16) {
        return {
          skipped: true,
          reason: 'Requires real browser WebGPU adapter without shader-f16.'
        };
      }

      const result = await realPage.evaluate(`(async () => {
        const svc = await import('/src/services/webllmService.js');

        // Unload previous ready engine via the real UI "Unload" button first and wait for React DOM commit
        const unloadBtn = Array.from(document.querySelectorAll('.browser-ai-action-btn')).find((b) =>
          (b.textContent || '').includes('Unload')
        );
        if (unloadBtn) {
          unloadBtn.click();
          const t0 = Date.now();
          while (Date.now() - t0 < 5000) {
            const hasLoadAgain = Array.from(document.querySelectorAll('.browser-ai-action-btn')).some((b) =>
              /Download & Load|Load Model/.test(b.textContent || '')
            );
            if (svc.getWebLLMState().status === 'idle' && svc.getWebLLMState().loadedModelId === null && hasLoadAgain) {
              break;
            }
            await new Promise((r) => setTimeout(r, 25));
          }
        }

        window.__orvixWorkerRecords.length = 0;
        const statusesDuringFailure = [];
        const unsub = svc.subscribeWebLLMState((st) => {
          statusesDuringFailure.push({
            status: st.status,
            loadedModelId: st.loadedModelId,
            error: st.error
          });
        });

        // Sub-case D1: FP32 WebGPU / device allocation failure inside worker initialization
        svc.setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
          handleInitProgress({ progress: 0.4, text: 'Loading FP32 model into GPU memory...', timeElapsed: 1 });
          await new Promise((r) => setTimeout(r, 20));
          throw new Error('DeviceLostError: Allocation failed — insufficient GPU memory for ' + modelId);
        });

        const loadBtn = Array.from(document.querySelectorAll('.browser-ai-action-btn')).find((b) =>
          /Download & Load|Load Model/.test(b.textContent || '')
        );
        if (!loadBtn) {
          throw new Error('Expected Download & Load / Load Model button after unload');
        }
        loadBtn.click();

        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const st = svc.getWebLLMState();
          const badge = document.querySelector('.browser-ai-status-badge')?.textContent?.trim();
          if (st.status === 'error' && badge === 'Error') break;
          await new Promise((r) => setTimeout(r, 25));
        }

        unsub();

        const errorStateD1 = svc.getWebLLMState();
        const statusBarEl = document.querySelector('.browser-ai-status-bar');
        const errorToneClass = statusBarEl?.className || '';
        const errorHeadline = document.querySelector('.browser-ai-headline')?.textContent?.trim() || '';
        const errorBadge = document.querySelector('.browser-ai-status-badge')?.textContent?.trim() || '';
        const errorDetail = document.querySelector('.browser-ai-detail')?.textContent?.trim() || '';
        const hasRetryBtn = Array.from(document.querySelectorAll('.browser-ai-action-btn')).some((b) =>
          (b.textContent || '').includes('Retry')
        );
        const hasProgressBar = Boolean(document.querySelector('.browser-ai-progress-track'));
        const modelSelectDisabled = Boolean(document.querySelector('.browser-ai-model-select')?.disabled);
        const d1WorkerRecords = window.__orvixWorkerRecords.map((w) => ({ ...w }));

        // Sub-case D2: Prompt submission while FP32 initialization also fails (verifying composer & chat error cleanup)
        const textarea = document.querySelector('form.composer-form textarea');
        const nativeValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        ).set;
        nativeValueSetter.call(textarea, 'Prompt when FP32 init fails');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
        document.querySelector('form.composer-form').requestSubmit();

        while (Date.now() < deadline) {
          const stopBtn = document.querySelector('.composer-stop-btn');
          const errBox = document.querySelector('.error-message-box');
          if (!stopBtn && errBox && svc.getWebLLMState().status === 'error') {
            await new Promise((r) => setTimeout(r, 40));
            if (!document.querySelector('.composer-stop-btn')) break;
          }
          await new Promise((r) => setTimeout(r, 30));
        }

        const errorStateD2 = svc.getWebLLMState();
        const d2WorkerRecords = window.__orvixWorkerRecords.map((w) => ({ ...w }));
        const composerStuckLoading = Boolean(document.querySelector('.composer-stop-btn'));
        const chatErrorTitle = document.querySelector('.error-message-box .error-header-title')?.textContent?.trim() || '';
        const chatErrorText = document.querySelector('.error-message-box .error-text')?.textContent?.trim() || '';

        return {
          statusesDuringFailure,
          errorStateD1,
          errorToneClass,
          errorHeadline,
          errorBadge,
          errorDetail,
          hasRetryBtn,
          hasProgressBar,
          modelSelectDisabled,
          d1WorkerRecords,
          errorStateD2,
          d2WorkerRecords,
          composerStuckLoading,
          chatErrorTitle,
          chatErrorText
        };
      })()`);

      // Verify model was NEVER falsely marked ready during or after failure
      const everReady = result.statusesDuringFailure.some(
        (s) => s.status === 'ready' || s.loadedModelId !== null
      );
      assert.strictEqual(everReady, false, 'Failed FP32 load must NEVER mark status="ready" or set loadedModelId');

      assert.strictEqual(result.errorStateD1.status, 'error');
      assert.strictEqual(result.errorStateD1.modelId, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.strictEqual(result.errorStateD1.loadedModelId, null);
      assert.ok(result.errorStateD1.error && result.errorStateD1.error.toLowerCase().includes('gpu memory'));

      // Verify UI displays error cleanly and is NOT stuck in loading state
      assert.ok(result.errorToneClass.includes('tone-error'));
      assert.strictEqual(result.errorBadge, 'Error');
      assert.strictEqual(result.errorHeadline, 'Qwen 2.5 1.5B (FP32) failed to load');
      assert.ok(result.errorDetail.toLowerCase().includes('gpu memory'));
      assert.strictEqual(result.hasRetryBtn, true);
      assert.strictEqual(result.hasProgressBar, false, 'Progress bar must be hidden after failure');
      assert.strictEqual(result.modelSelectDisabled, false, 'Model selector must be re-enabled after failure');

      // Verify spawned workers were terminated immediately on both failure paths
      assert.strictEqual(result.d1WorkerRecords.length, 1);
      assert.strictEqual(result.d1WorkerRecords[0].terminated, true, 'Failed FP32 worker (D1) must be terminated');

      assert.strictEqual(result.errorStateD2.status, 'error');
      assert.strictEqual(result.errorStateD2.loadedModelId, null);
      assert.strictEqual(result.composerStuckLoading, false, 'Composer must not remain in loading/stop state');
      assert.strictEqual(result.chatErrorTitle, 'GPU Memory Limit Reached');
      assert.ok(result.chatErrorText.toLowerCase().includes('gpu memory'));
      assert.ok(
        result.d2WorkerRecords.every((w) => w.terminated === true),
        'All workers spawned during failed FP32 prompt init must be terminated'
      );

      return {
        detail:
          'FP32 failure rendered actionable error in BrowserAIStatusBar, never marked ready, re-enabled controls, and terminated all spawned workers.'
      };
    }
  );

  await realPage.close();

  // --------------------------------------------------------------------------
  // SECTION 2: CONTROLLED BROWSER FEATURE-OVERRIDE REGRESSION CHECKS
  // (Explicitly separated from Section 1 — NOT claimed as physical shader-f16 hardware proof)
  // --------------------------------------------------------------------------
  console.log('\n--- Section 2: Controlled Browser Feature-Override Checks (Explicitly Non-Hardware Proof) ---');

  const overridePage = await browserHandle.newPage({
    initScripts: [
      GUEST_BOOTSTRAP_SCRIPT,
      `
        window.__orvixControlledShaderF16 = true;
        if (typeof GPUAdapter !== 'undefined' && GPUAdapter.prototype) {
          const origFeaturesDesc = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'features');
          if (origFeaturesDesc && typeof origFeaturesDesc.get === 'function') {
            Object.defineProperty(GPUAdapter.prototype, 'features', {
              configurable: true,
              get() {
                const realSet = origFeaturesDesc.get.call(this);
                return {
                  has(name) {
                    if (name === 'shader-f16' && typeof window.__orvixControlledShaderF16 === 'boolean') {
                      return window.__orvixControlledShaderF16;
                    }
                    return realSet.has(name);
                  },
                  [Symbol.iterator]() {
                    const items = new Set(Array.from(realSet));
                    if (window.__orvixControlledShaderF16 === true) items.add('shader-f16');
                    if (window.__orvixControlledShaderF16 === false) items.delete('shader-f16');
                    return items[Symbol.iterator]();
                  }
                };
              }
            });
          }
        }
      `
    ]
  });

  await waitForChatReady(overridePage, serverHandle.origin);

  await runCase(
    'Controlled Override A — Browser UI & service select FP16 (q4f16_1) and never switch to FP32 when adapter exposes shader-f16',
    'CONTROLLED-OVERRIDE',
    async () => {
      const check = await overridePage.evaluate(`(async () => {
        window.__orvixControlledShaderF16 = true;
        const svc = await import('/src/services/webllmService.js');
        svc.resetWebLLMRuntimeForTesting();

        const initModels = [];
        svc.setWebLLMEngineFactoryForTesting(async ({ worker, modelId, handleInitProgress }) => {
          initModels.push({ modelId, isRealWorker: worker instanceof Worker });
          handleInitProgress({ progress: 1, text: 'Finish loading' });
          return {
            forwardTokensAndSample: async () => 1,
            resetChat: async () => {},
            interruptGenerate: () => {},
            unload: async () => {},
            chat: { completions: { create: async () => (async function* () { yield { choices: [{ delta: { content: 'FP16 OK' } }] }; })() } }
          };
        });

        window.__setReactSelectValue('#ai-model-select-desktop', 'webllm');

        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const st = svc.getWebLLMState();
          if (st.hasShaderF16 === true && st.modelId === 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC') break;
          await new Promise((r) => setTimeout(r, 25));
        }

        const idleHeadline = document.querySelector('.browser-ai-headline')?.textContent?.trim() || '';
        const idleFootnote = document.querySelector('.composer-footnote')?.textContent?.trim() || '';

        const loadBtn = Array.from(document.querySelectorAll('.browser-ai-action-btn')).find((b) =>
          /Download & Load|Load Model/.test(b.textContent || '')
        );
        loadBtn.click();

        while (Date.now() < deadline) {
          if (svc.getWebLLMState().status === 'ready') break;
          await new Promise((r) => setTimeout(r, 25));
        }

        return {
          initModels,
          idleHeadline,
          idleFootnote,
          readyHeadline: document.querySelector('.browser-ai-headline')?.textContent?.trim() || '',
          readyFootnote: document.querySelector('.composer-footnote')?.textContent?.trim() || '',
          state: svc.getWebLLMState()
        };
      })()`);

      assert.strictEqual(check.initModels.length, 1);
      assert.strictEqual(check.initModels[0].modelId, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
      assert.strictEqual(check.initModels[0].isRealWorker, true);
      assert.strictEqual(check.state.modelId, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
      assert.strictEqual(check.state.loadedModelId, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
      assert.strictEqual(check.state.hasShaderF16, true);
      assert.strictEqual(check.idleHeadline, 'Qwen 2.5 1.5B — Browser AI');
      assert.strictEqual(check.readyHeadline, 'Qwen 2.5 1.5B — Ready on device');
      assert.ok(check.readyFootnote.includes('(Qwen 2.5 1.5B)'));
      assert.ok(!check.readyFootnote.includes('(FP32)'));

      return {
        detail:
          'Application branching verified in real Chromium DOM: retained Qwen2.5-1.5B-Instruct-q4f16_1-MLC with zero FP32 fallback (controlled feature override, not hardware proof).'
      };
    }
  );

  await runCase(
    'Controlled Override C2 — Reactive worker WGSL `enable f16;` rejection falls back to FP32 once and stays on FP32 across subsequent prompts',
    'CONTROLLED-OVERRIDE',
    async () => {
      const check = await overridePage.evaluate(`(async () => {
        window.__orvixControlledShaderF16 = true;
        const svc = await import('/src/services/webllmService.js');
        svc.resetWebLLMRuntimeForTesting();
        window.__orvixWorkerRecords.length = 0;

        const attemptedModels = [];
        svc.setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
          attemptedModels.push(modelId);
          if (modelId.includes('q4f16_1')) {
            throw new Error(
              "Error while parsing WGSL: :1:8 error: extension 'f16' is not allowed in the current environment\\nenable f16;"
            );
          }
          handleInitProgress({ progress: 1, text: 'Finish loading FP32 fallback' });
          return {
            forwardTokensAndSample: async () => 1,
            resetChat: async () => {},
            interruptGenerate: () => {},
            unload: async () => {},
            chat: {
              completions: {
                create: async () =>
                  (async function* () {
                    yield { choices: [{ delta: { content: 'Reactive FP32 reply.' } }] };
                  })()
              }
            }
          };
        });

        await svc.ensureWebLLMEngine({ modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' });
        const afterLoadState = svc.getWebLLMState();

        // Send a subsequent message passing the user's selected FP16 tier ID;
        // verify it reuses the loaded FP32 engine instead of tearing down and retrying FP16!
        const reply = await svc.streamWebLLMMessage({
          model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
          prompt: 'Second turn stability test'
        });

        return {
          attemptedModels,
          afterLoadState,
          afterPromptState: svc.getWebLLMState(),
          replyModelUsed: reply.modelUsed,
          workerRecords: window.__orvixWorkerRecords.map((w) => ({ ...w })),
          diagnostics: svc.getWebLLMDiagnostics().map((d) => d.stage)
        };
      })()`);

      assert.deepStrictEqual(check.attemptedModels, [
        'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'
      ]);
      assert.strictEqual(check.afterLoadState.status, 'ready');
      assert.strictEqual(check.afterLoadState.loadedModelId, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.strictEqual(check.afterLoadState.hasShaderF16, false);
      assert.strictEqual(check.replyModelUsed, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
      assert.ok(check.diagnostics.includes('init_f32_fallback'));
      assert.strictEqual(check.workerRecords.length, 2);
      assert.strictEqual(check.workerRecords[0].terminated, true, 'Failed FP16 worker must be terminated');
      assert.strictEqual(check.workerRecords[1].terminated, false, 'Active FP32 worker must remain alive and reused');

      return {
        detail:
          'Reactive WGSL f16 fallback terminated FP16 worker, loaded Qwen2.5-1.5B-Instruct-q4f32_1-MLC, persisted hasShaderF16=false, and reused FP32 worker on next prompt.'
      };
    }
  );

  await overridePage.close();
} finally {
  if (browserHandle) {
    await browserHandle.shutdown();
  }
  if (serverHandle) {
    await serverHandle.vite.close();
  }
}

console.log('\n========================================================================');
console.log(
  `📊 Summary: ${results.passed.length} passed, ${results.skipped.length} skipped (honest hardware skip), ${results.failed.length} failed`
);
console.log('========================================================================\n');

if (results.failed.length > 0) {
  process.exit(1);
}
