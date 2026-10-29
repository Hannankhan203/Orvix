/**
 * Orvix Browser AI Response Profiles (v0.2.9)
 * Isolated response profiles, prompt framing, generation hyperparameters,
 * and token cleanup strictly scoped to the three newly added offline models:
 *   1. SmolLM2 135M (SmolLM2-135M-Instruct-q0f16-MLC & FP32 fallback)
 *   2. SmolLM2 360M (SmolLM2-360M-Instruct-q4f16_1-MLC & FP32 fallback)
 *   3. Qwen3 0.6B   (Qwen3-0.6B-q4f16_1-MLC & FP32 fallback)
 *
 * INVARIANT:
 * Default Browser AI model (Qwen 2.5 1.5B Instruct) and all four cloud providers
 * (Gemini, Groq, OpenRouter, Cloudflare) are PROTECTED and MUST NOT use these profiles.
 */

export const REFINED_MODEL_KEYS = Object.freeze({
  SMOLLM2_135M: 'smollm2-135m',
  SMOLLM2_360M: 'smollm2-360m',
  QWEN3_06B: 'qwen3-06b'
});

export const TARGET_REFINED_MODEL_IDS = Object.freeze([
  'SmolLM2-135M-Instruct-q0f16-MLC',
  'SmolLM2-135M-Instruct-q0f32-MLC',
  'SmolLM2-360M-Instruct-q4f16_1-MLC',
  'SmolLM2-360M-Instruct-q4f32_1-MLC',
  'Qwen3-0.6B-q4f16_1-MLC',
  'Qwen3-0.6B-q4f32_1-MLC'
]);

/**
 * Maps model ID to profile key. Returns null for protected/unrefined models.
 */
export function getModelProfileKey(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const trimmed = modelId.trim();
  if (trimmed.startsWith('SmolLM2-135M-Instruct') || trimmed.toLowerCase().startsWith('smollm2-135m')) {
    return REFINED_MODEL_KEYS.SMOLLM2_135M;
  }
  if (trimmed.startsWith('SmolLM2-360M-Instruct') || trimmed.toLowerCase().startsWith('smollm2-360m')) {
    return REFINED_MODEL_KEYS.SMOLLM2_360M;
  }
  if (trimmed.startsWith('Qwen3-0.6B') || trimmed.toLowerCase().startsWith('qwen3-0.6b') || trimmed.toLowerCase().startsWith('qwen3-06b')) {
    return REFINED_MODEL_KEYS.QWEN3_06B;
  }
  return null;
}

/**
 * Returns true strictly if the given modelId is one of the three refined models.
 * Returns false for Qwen 2.5 1.5B and all cloud models.
 */
export function isRefinedTargetModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  return Boolean(getModelProfileKey(modelId));
}

/**
 * Profile specifications for the three target models.
 */
export const BROWSER_AI_PROFILES = Object.freeze({
  [REFINED_MODEL_KEYS.SMOLLM2_135M]: Object.freeze({
    key: REFINED_MODEL_KEYS.SMOLLM2_135M,
    label: 'SmolLM2 135M Instruct',
    tier: 'ultra-lightweight',
    temperature: Object.freeze({
      general: 0.2,
      coding: 0.1
    }),
    top_p: 0.85,
    repetition_penalty: 1.03,
    maxTokens: Object.freeze({
      concise: 128,
      default: 256,
      detailed: 512
    }),
    stop: Object.freeze([
      '<|endoftext|>',
      '<|im_end|>',
      '<|end_of_text|>',
      '\nUser:',
      '\nuser:',
      '\n\nUser:',
      '\n\nuser:'
    ]),
    maxInputChars: 5_000,
    systemPromptDescription: 'Minimal, direct plain-language instruction optimized for ultra-lightweight ~135M parameter capacity.'
  }),

  [REFINED_MODEL_KEYS.SMOLLM2_360M]: Object.freeze({
    key: REFINED_MODEL_KEYS.SMOLLM2_360M,
    label: 'SmolLM2 360M Instruct',
    tier: 'compact',
    temperature: Object.freeze({
      general: 0.3,
      coding: 0.15
    }),
    top_p: 0.85,
    repetition_penalty: 1.04,
    maxTokens: Object.freeze({
      concise: 256,
      default: 512,
      detailed: 896
    }),
    stop: Object.freeze([
      '<|endoftext|>',
      '<|im_end|>',
      '<|end_of_text|>',
      '\nUser:',
      '\nuser:',
      '\n\nUser:',
      '\n\nuser:'
    ]),
    maxInputChars: 8_000,
    systemPromptDescription: 'Clean, direct instruction prioritizing structured answers and instruction following for compact ~360M parameter model.'
  }),

  [REFINED_MODEL_KEYS.QWEN3_06B]: Object.freeze({
    key: REFINED_MODEL_KEYS.QWEN3_06B,
    label: 'Qwen3 0.6B',
    tier: 'lightweight',
    temperature: Object.freeze({
      general: 0.3,
      coding: 0.15
    }),
    top_p: 0.85,
    repetition_penalty: 1.05,
    extra_body: Object.freeze({
      enable_thinking: false
    }),
    maxTokens: Object.freeze({
      concise: 256,
      default: 512,
      detailed: 1024
    }),
    stop: Object.freeze([
      '<|im_end|>',
      '<|endoftext|>',
      '<|im_start|>',
      '<|end_of_text|>',
      '<|assistant|>',
      '<|user|>',
      '<|system|>',
      '\nUser:',
      '\nuser:',
      '\n\nUser:',
      '\n\nuser:'
    ]),
    maxInputChars: 10_000,
    systemPromptDescription: 'Clean direct instruction bypassing reasoning drift with non-thinking execution for Qwen3 0.6B.'
  })
});

/**
 * Returns the profile for a given model ID, or null if the model is not one of the 3 target models.
 */
export function getBrowserAiModelProfile(modelId) {
  const profileKey = getModelProfileKey(modelId);
  if (!profileKey) return null;
  return BROWSER_AI_PROFILES[profileKey] || null;
}

/**
 * Builds a tailored system instruction for the target model.
 * If model is not a target model, returns null.
 */
export function buildProfileSystemInstruction(modelId, { username = null, preferences = null, mode = 'general' } = {}) {
  const profileKey = getModelProfileKey(modelId);
  if (!profileKey) return null;

  const cleanName = username && String(username).trim()
    ? String(username).trim().slice(0, 50).replace(/[\r\n\t]/g, ' ')
    : null;

  if (profileKey === REFINED_MODEL_KEYS.SMOLLM2_135M) {
    if (mode === 'coding') {
      return 'You are a helpful assistant. Provide clean, working code directly.';
    }

    const parts = ['You are a helpful assistant. Answer the question directly in simple words.'];

    if (cleanName) {
      parts.push(`User name: ${cleanName}.`);
    }

    if (preferences?.responseLength === 'concise') {
      parts.push('Keep answers brief.');
    } else if (preferences?.responseLength === 'detailed') {
      parts.push('Explain clearly with simple steps.');
    }

    return parts.join(' ');
  }

  if (profileKey === REFINED_MODEL_KEYS.SMOLLM2_360M) {
    if (mode === 'coding') {
      return 'You are a helpful assistant. Provide clear, correct code with brief explanations.';
    }

    const parts = ['You are a helpful assistant. Answer the user\'s question directly and follow any formatting instructions.'];

    if (cleanName) {
      parts.push(`User name: ${cleanName}.`);
    }

    if (preferences?.responseLength === 'concise') {
      parts.push('Keep answers brief and to the point.');
    } else if (preferences?.responseLength === 'detailed') {
      parts.push('Provide structured explanations with clear examples.');
    }

    return parts.join(' ');
  }

  if (profileKey === REFINED_MODEL_KEYS.QWEN3_06B) {
    if (mode === 'coding') {
      return 'You are a helpful assistant. Provide clean, efficient code with clear explanations.';
    }

    const parts = ['You are a helpful assistant. Answer the user\'s question directly, accurately, and follow all instructions.'];

    if (cleanName) {
      parts.push(`User name: ${cleanName}.`);
    }

    if (preferences?.responseLength === 'concise') {
      parts.push('Keep answers brief and to the point.');
    } else if (preferences?.responseLength === 'detailed') {
      parts.push('Provide organized, thorough explanations.');
    }

    return parts.join(' ');
  }

  return null;
}

/**
 * Resolves generation parameters for the model.
 * If model is NOT one of the 3 target models, returns baseline Qwen 2.5 1.5B parameters.
 */
export function resolveProfileGenerationParams(modelId, {
  mode = 'general',
  preferences = null,
  temperature = undefined,
  top_p = undefined,
  topP = undefined,
  max_tokens = undefined,
  maxTokens = undefined,
  repetition_penalty = undefined
} = {}) {
  // Baseline Qwen 2.5 1.5B (and unrefined models): strictly preserve existing behavior
  if (!isRefinedTargetModel(modelId)) {
    let effectiveTemperature = mode === 'coding' ? 0.3 : 0.7;
    if (temperature !== undefined) {
      const numTemp = Number(temperature);
      if (Number.isFinite(numTemp) && numTemp >= 0 && numTemp <= 2) {
        effectiveTemperature = numTemp;
      }
    }

    let effectiveTopP = 0.9;
    const rawTopP = top_p !== undefined ? top_p : topP;
    if (rawTopP !== undefined) {
      const numTopP = Number(rawTopP);
      if (Number.isFinite(numTopP) && numTopP > 0 && numTopP <= 1) {
        effectiveTopP = numTopP;
      }
    }

    const rawMaxTokens = max_tokens !== undefined ? max_tokens : maxTokens;
    let customMaxTokens = undefined;
    if (rawMaxTokens !== undefined) {
      const numMax = Number(rawMaxTokens);
      if (Number.isFinite(numMax) && numMax > 0) {
        customMaxTokens = Math.floor(numMax);
      }
    }

    const effectiveMaxTokens = customMaxTokens ||
      (preferences?.responseLength === 'concise'
        ? 512
        : preferences?.responseLength === 'detailed'
          ? 1536
          : 1024);

    return {
      temperature: effectiveTemperature,
      top_p: effectiveTopP,
      max_tokens: effectiveMaxTokens,
      repetition_penalty: repetition_penalty !== undefined ? Number(repetition_penalty) : undefined,
      stop: undefined,
      extra_body: undefined,
      maxInputChars: 12_500,
      isRefined: false
    };
  }

  const profile = getBrowserAiModelProfile(modelId);
  const isCoding = mode === 'coding';

  // 1. Temperature: respect caller explicit override if valid; otherwise use calibrated profile value
  let effectiveTemp = isCoding ? profile.temperature.coding : profile.temperature.general;
  if (temperature !== undefined) {
    const num = Number(temperature);
    if (Number.isFinite(num) && num >= 0 && num <= 2) {
      effectiveTemp = num;
    }
  }

  // 2. Top-p: respect caller override if valid; otherwise use calibrated profile value
  const callerTopP = top_p !== undefined ? top_p : topP;
  let effectiveTopP = profile.top_p;
  if (callerTopP !== undefined) {
    const num = Number(callerTopP);
    if (Number.isFinite(num) && num > 0 && num <= 1) {
      effectiveTopP = num;
    }
  }

  // 3. Repetition penalty: respect caller override if valid; otherwise use calibrated profile value
  let effectiveRepPenalty = profile.repetition_penalty;
  if (repetition_penalty !== undefined) {
    const num = Number(repetition_penalty);
    if (Number.isFinite(num) && num > 0) {
      effectiveRepPenalty = num;
    }
  }

  // 4. Max tokens: respect caller override if valid; otherwise evaluate responseLength preference
  const rawMax = max_tokens !== undefined ? max_tokens : maxTokens;
  let effectiveMaxTokens;
  if (rawMax !== undefined) {
    const num = Number(rawMax);
    if (Number.isFinite(num) && num > 0) {
      effectiveMaxTokens = Math.floor(num);
    } else {
      effectiveMaxTokens = profile.maxTokens.default;
    }
  } else {
    if (preferences?.responseLength === 'concise') {
      effectiveMaxTokens = profile.maxTokens.concise;
    } else if (preferences?.responseLength === 'detailed') {
      effectiveMaxTokens = profile.maxTokens.detailed;
    } else {
      effectiveMaxTokens = profile.maxTokens.default;
    }
  }

  return {
    temperature: effectiveTemp,
    top_p: effectiveTopP,
    repetition_penalty: effectiveRepPenalty,
    max_tokens: effectiveMaxTokens,
    stop: [...profile.stop],
    extra_body: profile.extra_body ? { ...profile.extra_body } : undefined,
    maxInputChars: profile.maxInputChars,
    isRefined: true
  };
}

/**
 * Deduplicates trailing runaway loops from small models (e.g. repeated lines at the very end).
 */
function deduplicateTrailingLoops(text) {
  if (!text || text.length < 30) return text;

  const lines = text.split('\n');
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    // Check if the final line is a degenerate 3+ repetition of a phrase >= 12 chars
    const match = lastLine.match(/^(.{12,}?)\1{2,}$/);
    if (match && match[1]) {
      lines[lines.length - 1] = match[1].trim();
      return lines.join('\n');
    }
  }

  return text;
}

/**
 * Post-processes model output to strip leaked special tokens, delimiter tags,
 * and internal thought blocks for the three refined models.
 * For unrefined models (Qwen 2.5 1.5B and cloud models), returns rawText unmodified.
 */
export function cleanModelOutput(rawText, modelId) {
  if (!isRefinedTargetModel(modelId)) {
    return rawText;
  }

  if (typeof rawText !== 'string' || !rawText) {
    return '';
  }

  let text = rawText;

  // 1. Truncate at first explicit stop/EOS delimiter or simulated turn
  const turnStops = [
    '<|im_end|>',
    '<|endoftext|>',
    '<|end_of_text|>',
    '\nUser:',
    '\nuser:',
    '\n\nUser:',
    '\n\nuser:',
    '\nHuman:',
    '\nhuman:'
  ];
  let earliestStop = -1;
  for (const stopToken of turnStops) {
    const idx = text.indexOf(stopToken);
    if (idx !== -1 && (earliestStop === -1 || idx < earliestStop)) {
      earliestStop = idx;
    }
  }
  if (earliestStop !== -1) {
    text = text.slice(0, earliestStop);
  }

  // 2. Strip leaked delimiter markers
  text = text.replace(/<\|im_start\|>(?:assistant|user|system)?/gi, '');
  text = text.replace(/<\|im_end\|>/gi, '');
  text = text.replace(/<\|(?:assistant|user|system)\|>/gi, '');
  text = text.replace(/<\|endoftext\|>/gi, '');
  text = text.replace(/<\|end_of_text\|>/gi, '');

  // 3. Handle <think>...</think> tags if model leaks reasoning tokens
  if (text.includes('<think>')) {
    if (text.includes('</think>')) {
      const parts = text.split('</think>');
      const afterThink = parts.slice(1).join('</think>').trim();
      if (afterThink.length > 0) {
        text = afterThink;
      } else {
        // Response was fully inside <think>...</think>
        text = text.replace(/<\/?think>/gi, '').trim();
      }
    } else {
      text = text.replace(/^<think>\s*/i, '');
    }
  } else if (text.includes('</think>')) {
    const parts = text.split('</think>');
    const afterThink = parts.slice(1).join('</think>').trim();
    if (afterThink.length > 0) {
      text = afterThink;
    } else {
      text = text.replace(/<\/think>/gi, '').trim();
    }
  }

  // 4. Strip leading assistant/system echoes if model prefixed its output
  text = text.replace(/^(?:assistant|orvix|ai|system):\s*/i, '');

  // 5. Clean up degenerate ending repetitions
  text = deduplicateTrailingLoops(text);

  return text.trim();
}

/**
 * Creates a streaming response sanitizer for the target models.
 * For unrefined models, provides pass-through streaming.
 */
export function createStreamingResponseSanitizer(modelId, { onChunk, onStopDetected } = {}) {
  if (!isRefinedTargetModel(modelId)) {
    return {
      feed(delta, rawAccumulated) {
        onChunk?.(delta, rawAccumulated);
      },
      flush() {},
      isStopped() {
        return false;
      }
    };
  }

  let buffer = '';
  let accumulatedClean = '';
  let stopped = false;
  let inThinkBlock = false;
  let hasEmittedFirstChunk = false;

  const STOP_PATTERNS = [
    '<|im_end|>',
    '<|endoftext|>',
    '<|end_of_text|>',
    '<|im_start|>',
    '<|assistant|>',
    '<|user|>',
    '<|system|>',
    '\nUser:',
    '\nuser:',
    '\n\nUser:',
    '\n\nuser:',
    '\nHuman:',
    '\nhuman:'
  ];

  return {
    feed(delta) {
      if (stopped) return;
      buffer += delta;

      // Handle <think>...</think> blocks
      if (!inThinkBlock && buffer.includes('<think>')) {
        inThinkBlock = true;
      }
      if (inThinkBlock) {
        if (buffer.includes('</think>')) {
          buffer = buffer.slice(buffer.indexOf('</think>') + 8);
          inThinkBlock = false;
        } else {
          // Still accumulating think tokens, do not emit
          return;
        }
      }

      // Check for full stop pattern in buffer
      for (const pattern of STOP_PATTERNS) {
        const idx = buffer.indexOf(pattern);
        if (idx !== -1) {
          let validPart = buffer.slice(0, idx);
          if (!hasEmittedFirstChunk) {
            validPart = validPart.replace(/^(?:assistant|orvix|ai|system):\s*/i, '');
          }
          if (validPart) {
            hasEmittedFirstChunk = true;
            accumulatedClean += validPart;
            onChunk?.(validPart, accumulatedClean);
          }
          stopped = true;
          onStopDetected?.();
          return;
        }
      }

      // Check if buffer ends with a prefix of a stop pattern (e.g. '<|' or '\nU')
      let longestPrefixLen = 0;
      for (const pattern of STOP_PATTERNS) {
        for (let len = 1; len < pattern.length; len++) {
          if (buffer.endsWith(pattern.slice(0, len))) {
            if (len > longestPrefixLen) {
              longestPrefixLen = len;
            }
          }
        }
      }

      if (
        buffer.endsWith('<') ||
        buffer.endsWith('<t') ||
        buffer.endsWith('<th') ||
        buffer.endsWith('<thi') ||
        buffer.endsWith('<thin') ||
        buffer.endsWith('<think')
      ) {
        longestPrefixLen = Math.max(longestPrefixLen, buffer.length - buffer.lastIndexOf('<'));
      }

      if (longestPrefixLen > 0) {
        let safePart = buffer.slice(0, buffer.length - longestPrefixLen);
        if (!hasEmittedFirstChunk && safePart) {
          safePart = safePart.replace(/^(?:assistant|orvix|ai|system):\s*/i, '');
        }
        if (safePart) {
          hasEmittedFirstChunk = true;
          accumulatedClean += safePart;
          onChunk?.(safePart, accumulatedClean);
          buffer = buffer.slice(buffer.length - longestPrefixLen);
        }
      } else {
        let emitPart = buffer;
        if (!hasEmittedFirstChunk && emitPart) {
          emitPart = emitPart.replace(/^(?:assistant|orvix|ai|system):\s*/i, '');
        }
        if (emitPart) {
          hasEmittedFirstChunk = true;
          accumulatedClean += emitPart;
          onChunk?.(emitPart, accumulatedClean);
        }
        buffer = '';
      }
    },
    flush() {
      if (stopped) return;
      if (buffer) {
        let validPart = buffer;
        if (inThinkBlock) {
          if (validPart.includes('</think>')) {
            validPart = validPart.slice(validPart.indexOf('</think>') + 8);
          } else {
            validPart = validPart.replace(/<\/?think>/gi, '');
          }
        }
        for (const pattern of STOP_PATTERNS) {
          const idx = validPart.indexOf(pattern);
          if (idx !== -1) {
            validPart = validPart.slice(0, idx);
          }
        }
        if (!hasEmittedFirstChunk) {
          validPart = validPart.replace(/^(?:assistant|orvix|ai|system):\s*/i, '');
        }
        if (validPart) {
          accumulatedClean += validPart;
          onChunk?.(validPart, accumulatedClean);
        }
        buffer = '';
      }
    },
    isStopped() {
      return stopped;
    }
  };
}
