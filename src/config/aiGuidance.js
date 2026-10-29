/**
 * Orvix AI Model Selection Guidance Configuration
 *
 * Provides static, concise informational guidance describing the main characteristics
 * and trade-offs of each supported AI provider and Browser AI (WebLLM) model.
 *
 * Requirements:
 * - All messages MUST be static text constants (no external calls, no LLM generation).
 * - Exact text required by Orvix AI Model Selection Guidance UX specification.
 * - Dynamic resolution based on active provider and active Browser AI model.
 */

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  QWEN3_06B_F32_WEBLLM_MODEL_ID
} from '../services/webllmService.js';

export const AI_PROVIDER_GUIDANCE = Object.freeze({
  gemini: 'Powerful general-purpose AI — delivers strong responses across a wide range of tasks, with cloud processing required.',
  groq: 'Fast cloud AI — optimized for very quick responses while providing strong general-purpose capabilities.',
  openrouter: 'Flexible cloud AI — provides access to supported models through OpenRouter, with capabilities depending on the selected model.',
  cloudflare: 'Cloud AI running through Cloudflare — provides convenient AI access with capabilities depending on the selected model.'
});

export const BROWSER_AI_MODEL_GUIDANCE = Object.freeze({
  [DEFAULT_WEBLLM_MODEL_ID]: 'Balanced Browser AI choice — offers the strongest overall response quality among the local models, but requires more resources than the smaller models.',
  [FALLBACK_F32_WEBLLM_MODEL_ID]: 'Balanced Browser AI choice — offers the strongest overall response quality among the local models, but requires more resources than the smaller models.',
  [SMOLLM2_135M_WEBLLM_MODEL_ID]: 'Ultra-lightweight Browser AI — uses the least resources, but responses may be less accurate or detailed, especially for complex questions.',
  [SMOLLM2_135M_F32_WEBLLM_MODEL_ID]: 'Ultra-lightweight Browser AI — uses the least resources, but responses may be less accurate or detailed, especially for complex questions.',
  [SMOLLM2_360M_WEBLLM_MODEL_ID]: 'Lightweight Browser AI — offers a good balance between low resource usage and response quality, though it may be less capable than the larger local models.',
  [SMOLLM2_360M_F32_WEBLLM_MODEL_ID]: 'Lightweight Browser AI — offers a good balance between low resource usage and response quality, though it may be less capable than the larger local models.',
  [QWEN3_06B_WEBLLM_MODEL_ID]: 'Lightweight Browser AI — provides stronger response quality than the smallest models while using fewer resources than Qwen 2.5 1.5B.',
  [QWEN3_06B_F32_WEBLLM_MODEL_ID]: 'Lightweight Browser AI — provides stronger response quality than the smallest models while using fewer resources than Qwen 2.5 1.5B.'
});

/**
 * Resolves the informational guidance text for the currently active AI selection.
 *
 * @param {string} providerId - Active provider ID ('gemini' | 'groq' | 'openrouter' | 'cloudflare' | 'webllm')
 * @param {string} [webllmModelId] - Active Browser AI model ID when provider is 'webllm'
 * @returns {string} The concise guidance text for the active choice
 */
export function getAISelectionGuidance(providerId, webllmModelId = DEFAULT_WEBLLM_MODEL_ID) {
  const normalizedProvider = String(providerId || '').toLowerCase().trim();

  if (normalizedProvider === 'webllm') {
    const targetModelId = webllmModelId || DEFAULT_WEBLLM_MODEL_ID;
    return (
      BROWSER_AI_MODEL_GUIDANCE[targetModelId] ||
      BROWSER_AI_MODEL_GUIDANCE[DEFAULT_WEBLLM_MODEL_ID]
    );
  }

  if (AI_PROVIDER_GUIDANCE[normalizedProvider]) {
    return AI_PROVIDER_GUIDANCE[normalizedProvider];
  }

  // Default to Gemini guidance as the primary cloud provider reference
  return AI_PROVIDER_GUIDANCE.gemini;
}
