/**
 * Orvix Dedicated WebLLM Web Worker
 * Runs @mlc-ai/web-llm inference, tokenization, and WebGPU shader execution off the main UI thread.
 *
 * Verified against @mlc-ai/web-llm@0.2.86:
 * - WebWorkerMLCEngineHandler() instantiates an internal MLCEngine and forwards InitProgressReport
 *   messages back to the main thread via postMessage.
 * - Wrapping handler.onmessage in an arrow function preserves `this` binding on every worker message.
 */

import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const workerBootMs = Date.now();
const handler = new WebWorkerMLCEngineHandler();

console.log('[Orvix WebLLM Worker][stage=worker_boot] (+0ms) Dedicated WebLLM worker initialized');

self.onmessage = (event) => {
  const kind = typeof event?.data?.kind === 'string' ? event.data.kind : null;
  if (kind === 'reload' || kind === 'unload') {
    const modelId = Array.isArray(event?.data?.content?.modelId)
      ? event.data.content.modelId.join(',')
      : event?.data?.content?.modelId || 'default';
    console.log(
      `[Orvix WebLLM Worker][stage=worker_${kind}] (+${Date.now() - workerBootMs}ms) modelId=${String(modelId)}`
    );
  }
  try {
    handler.onmessage(event);
  } catch (err) {
    console.error('[Orvix WebLLM Worker][stage=worker_handler_exception]', err);
  }
};

self.addEventListener('unhandledrejection', (event) => {
  console.error('[Orvix WebLLM Worker] Unhandled promise rejection:', event?.reason || event);
});

self.addEventListener('error', (event) => {
  console.error('[Orvix WebLLM Worker] Uncaught worker error:', event?.error || event?.message || event);
});
