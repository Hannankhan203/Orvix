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

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (event) => {
  try {
    handler.onmessage(event);
  } catch (err) {
    console.error('[Orvix WebLLM Worker] Failed to handle message:', err);
  }
};

self.addEventListener('unhandledrejection', (event) => {
  console.error('[Orvix WebLLM Worker] Unhandled promise rejection:', event?.reason || event);
});

self.addEventListener('error', (event) => {
  console.error('[Orvix WebLLM Worker] Uncaught worker error:', event?.error || event?.message || event);
});
