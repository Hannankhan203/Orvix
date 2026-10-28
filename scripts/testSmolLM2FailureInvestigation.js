import assert from 'node:assert';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  resolveWebLLMModelId,
  inspectWebLLMReadiness,
  ensureWebLLMEngine,
  getWebLLMState,
  resetWebLLMRuntimeForTesting,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting
} from '../src/services/webllmService.js';

console.log('Investigating WebLLM State and Model Selection flow...');

// Mock browser
globalThis.window = { isSecureContext: true };
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      onLine: true,
      gpu: {
        requestAdapter: async () => ({
          features: new Set(['shader-f16']),
          limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
          info: { vendor: 'test', architecture: 'test', description: 'test' }
        })
      },
      storage: {
        estimate: async () => ({ quota: 10e9, usage: 1e8 }),
        persist: async () => true
      }
    },
    configurable: true,
    writable: true
  });
} catch (_) {}
globalThis.caches = {
  open: async () => ({
    match: async () => null,
    keys: async () => []
  }),
  has: async () => false
};

// Scenario 1: Initial state
resetWebLLMRuntimeForTesting();
console.log('Initial state:', getWebLLMState());

// Simulate Qwen was loaded
// If Qwen was loaded, status is 'ready', modelId is DEFAULT_WEBLLM_MODEL_ID
let mockEngine = { chat: { completions: {} }, unload: async () => {} };
setWebLLMWorkerFactoryForTesting(() => ({
  onmessage: null,
  postMessage: () => {},
  terminate: () => {},
  addEventListener: () => {},
  removeEventListener: () => {}
}));
setWebLLMEngineFactoryForTesting(async () => mockEngine);

await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
console.log('State after Qwen load:', getWebLLMState());
assert.strictEqual(getWebLLMState().status, 'ready');
assert.strictEqual(getWebLLMState().modelId, DEFAULT_WEBLLM_MODEL_ID);

// Now user selects SmolLM2 in dropdown!
// ChatPage calls inspectWebLLMReadiness(SMOLLM2_135M_WEBLLM_MODEL_ID)
console.log('\nUser selects SmolLM2 135M...');
await inspectWebLLMReadiness(SMOLLM2_135M_WEBLLM_MODEL_ID);
const stateAfterSwitch = getWebLLMState();
console.log('State after inspectWebLLMReadiness(SmolLM2):', stateAfterSwitch);

// CHECK THE BUG:
// Did status stay 'ready' while modelId changed to SmolLM2?
console.log('Is status ready?', stateAfterSwitch.status === 'ready');
console.log('Is state.modelId SmolLM2?', stateAfterSwitch.modelId === SMOLLM2_135M_WEBLLM_MODEL_ID);

// Now simulate BrowserAIStatusBar condition with NEW logic:
const selectedModelId = SMOLLM2_135M_WEBLLM_MODEL_ID;
const loadedModelId = stateAfterSwitch.loadedModelId || null;
const status = stateAfterSwitch.status || 'idle';
const selectedCatalog = WEBLLM_MODEL_CATALOG[selectedModelId];

const isLoadedInGpu = Boolean(loadedModelId && (status === 'ready' || status === 'generating'));
const newLoadedMatchesSelected =
  isLoadedInGpu &&
  (loadedModelId === selectedModelId ||
    selectedCatalog?.f32FallbackModelId === loadedModelId);

console.log('New loadedMatchesSelected in BrowserAIStatusBar:', newLoadedMatchesSelected);
assert.strictEqual(newLoadedMatchesSelected, false, 'SmolLM2 should NOT be considered loaded when Qwen is in GPU memory');

// Now simulate user clicking Download & Load for SmolLM2
console.log('User clicks Download & Load for SmolLM2 135M...');
await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
const stateAfterSmolLoad = getWebLLMState();
console.log('State after loading SmolLM2:', stateAfterSmolLoad);
assert.strictEqual(stateAfterSmolLoad.status, 'ready');
assert.strictEqual(stateAfterSmolLoad.loadedModelId, SMOLLM2_135M_WEBLLM_MODEL_ID);

const smolLoadedMatchesSelected =
  Boolean(stateAfterSmolLoad.loadedModelId && (stateAfterSmolLoad.status === 'ready')) &&
  (stateAfterSmolLoad.loadedModelId === selectedModelId ||
    selectedCatalog?.f32FallbackModelId === stateAfterSmolLoad.loadedModelId);

console.log('SmolLM2 loadedMatchesSelected after load:', smolLoadedMatchesSelected);
assert.strictEqual(smolLoadedMatchesSelected, true);
console.log('SUCCESS: All checks passed!');
