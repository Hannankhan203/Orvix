import type express from 'express';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';

import type {
  DocumentData,
  PreparedDocumentContext,
  UserPreferences,
  AIDiagnosticCategory,
  VerifiedUserIdentity
} from './serverTypes.ts';

import {
  logAIDiagnostic,
  logGeminiLifecycleEvent,
  sanitizeErrorLog
} from './diagnosticLogger.ts';

import {
  getGroqApiBaseUrl,
  getOpenRouterApiBaseUrl,
  getCloudflareApiBaseUrl,
  getGroqApiKey,
  getOpenRouterApiKey,
  getGeminiApiKey,
  getCloudflareCredentials,
  isServerless,
  getUpstreamHeadersTimeoutMs,
  getGeminiHeaderTimeoutMs,
  getGeminiFirstByteTimeoutMs,
  getGeminiStreamInactivityTimeoutMs,
  getGeminiTotalRequestTimeoutMs,
  getGeminiUnaryTimeoutMs,
  isDemoModeEnabled,
  isConfiguredCredential,
  getConfiguredFallbackProviders,
  sendProviderNotConfiguredError,
  createRequestUpstreamGuard,
  sleepWithAbort,
  getBackoffWithJitter
} from './serverConfig.ts';

import {
  consumeGeminiStreamWithWatchdog,
  parseGeminiError,
  formatGeminiHistory
} from './geminiStreamHandler.ts';

import {
  fileRegistry,
  conversationDocuments,
  UPLOAD_DIR,
  buildGeminiImageParts,
  authenticateUploadRequest
} from './uploadSubsystem.ts';

// @ts-ignore - Document extraction JavaScript service
import { extractDocumentContent } from '../src/services/documentExtractor.js';
// @ts-ignore - Image OCR extraction JavaScript service
import { extractImageText } from '../src/services/imageOcrService.js';
// @ts-ignore - Document context JavaScript service
import {
  prepareDocumentContext,
  generateSimulatedDocumentResponse,
  adaptDocumentContextForProvider,
  formatOpenAIMessages,
  isVisionCapableProvider,
  isImageAttachment
} from '../src/services/documentContextService.js';
// @ts-ignore - Multi-part large response handling service
import {
  detectLargeResponseIntent,
  isContinuationRequest,
  resolveMultiPartContext,
  buildMultiPartPromptAugmentation,
  generateSimulatedMultiPartResponse,
  responseHasContinuationNotice,
  CONTINUATION_NOTICES
} from '../src/services/multiPartResponseService.js';
// @ts-ignore - Context-aware spoken transcript polisher
import { polishSpokenTranscript } from '../src/utils/speechTextCleaner.js';
// @ts-ignore - Shared attachment payload validation and vision image-part builder
import {
  MAX_VISION_IMAGE_BYTES,
  MAX_CHAT_REQUEST_BYTES
} from '../src/services/attachmentStorageService.js';
// @ts-ignore - Shared provider configuration and model identifier validator
import {
  validateServerModelForProvider,
  GROQ_FALLBACK_CHAT_MODELS,
  getProviderDisplayName,
  PROVIDER_DEFAULT_MODELS,
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL,
  GEMINI_FALLBACK_CANDIDATES
} from '../src/services/providerModelSanitizer.js';

export function buildSystemInstruction(
  username?: string | null,
  preferences?: UserPreferences | null,
  mode?: string | null
) {
  const baseInstruction =
    'You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.';

  const instructions = [baseInstruction];

  if (username && username.trim()) {
    const cleanName = username.trim().slice(0, 50).replace(/[\r\n\t]/g, ' ');
    instructions.push(
      `The user's preferred name is ${cleanName}. You may address the user by this name naturally when appropriate. Do not overuse the name, do not invent additional personal information, and do not claim to remember information that has not been provided.`
    );
  }

  // Consistent, non-intrusive response preferences layer
  if (preferences?.responseLength === 'concise') {
    instructions.push(
      'Preferred response length: Concise. Keep explanations brief, compact, focused, and directly to the point without filler or redundant commentary.'
    );
  } else if (preferences?.responseLength === 'detailed') {
    instructions.push(
      'Preferred response length: Detailed. Provide thorough, in-depth explanations with helpful background context, step-by-step reasoning, and practical code or concepts where appropriate.'
    );
  } else if (preferences?.responseLength === 'balanced') {
    instructions.push(
      'Preferred response length: Balanced. Provide an optimal balance between conciseness and thoroughness.'
    );
  }

  if (preferences?.beginnerFriendly) {
    instructions.push(
      'Explanation style: Clear and beginner-friendly. Explain technical and complex topics using plain language, accessible analogies, and approachable steps, avoiding unnecessary jargon without talking down to the user.'
    );
  }

  // Active Chat Mode instruction layer
  const normalizedMode = (mode || 'general').toLowerCase().trim();
  if (normalizedMode === 'coding') {
    instructions.push(
      'Active Mode: Coding. Prioritize high-quality programming guidance, software architecture, syntax review, and debugging. Provide clean, correct, and well-structured code blocks with accurate language identifiers. Explain how the code operates, highlight edge cases or potential pitfalls, and guide the user through step-by-step technical problem solving without making ungrounded assumptions.'
    );
  } else if (normalizedMode === 'writing') {
    instructions.push(
      'Active Mode: Writing. Prioritize drafting, editing, rewriting, tone adjustment, and prose enhancement. Focus on clarity, flow, rhythm, grammatical precision, and compelling structure. Offer constructive suggestions, varied phrasing alternatives, and polished text tailored to the user\'s intended audience and purpose.'
    );
  } else if (normalizedMode === 'learning') {
    instructions.push(
      'Active Mode: Learning. Prioritize clear educational explanations and concept mastery. Break complex topics down into logical, easily digestible steps. Use relatable real-world analogies, illustrative examples, and intuitive comparisons. Encourage deep understanding by highlighting key takeaways and offering helpful conceptual summaries.'
    );
  }

  return instructions.join(' ');
}

export function generateSimulatedResponse(
  promptText = '',
  username: string | null = null,
  preferences?: UserPreferences | null,
  mode?: string | null
) {
  const promptLower = promptText.toLowerCase();
  const greetingName = username ? ` ${username}` : '';
  const personalSignoff = username ? `, ${username}` : '';
  const isConcise = preferences?.responseLength === 'concise';
  const isDetailed = preferences?.responseLength === 'detailed';
  const isBeginner = Boolean(preferences?.beginnerFriendly);
  const normalizedMode = (mode || 'general').toLowerCase().trim();

  // Context-aware speech transcript polish simulation
  if (
    promptLower.includes('transcript polisher') ||
    promptLower.includes('phonetic speech recognition glitches')
  ) {
    const transcriptMatch = promptText.match(/Transcript:\s*\n?["'«»“]([\s\S]*?)["'«»”]\s*$/i);
    const rawTranscript = transcriptMatch ? transcriptMatch[1].trim() : promptText.trim();
    if (rawTranscript) {
      let polished = rawTranscript;
      const combined = `${promptLower} ${polished.toLowerCase()}`;
      const isProgramming =
        combined.includes('javascript') ||
        combined.includes('ecmascript') ||
        combined.includes('typescript') ||
        combined.includes('code') ||
        combined.includes('programming') ||
        combined.includes('function') ||
        combined.includes('algorithm');

      polished = polished
        .replace(/\bjava\s*script\b/gi, 'JavaScript')
        .replace(/\becma\s*script\b/gi, 'ECMAScript')
        .replace(/\btype\s*script\b/gi, 'TypeScript')
        .replace(/\bmath\s*\.\s*random\b/gi, 'Math.random')
        .replace(/\busing\s+math\s+random\b/gi, 'using Math.random')
        .replace(/\bapi\b/gi, 'API')
        .replace(/\bdom\b/gi, 'DOM')
        .replace(/\bhtml\b/gi, 'HTML')
        .replace(/\bcss\b/gi, 'CSS')
        .replace(/\bsse\b/gi, 'SSE')
        .replace(/\bjson\b/gi, 'JSON')
        .replace(/\bui\b/gi, 'UI')
        .replace(/\bux\b/gi, 'UX')
        .replace(/\bgpu\b/gi, 'GPU')
        .replace(/\bweb\s*llm\b/gi, 'WebLLM')
        .replace(/\borvix\b/gi, 'Orvix');

      if (isProgramming) {
        polished = polished
          .replace(/\bpromis\b/gi, 'Promise')
          .replace(/\bpromiss\b/gi, 'Promise')
          .replace(/\bpromises\b/gi, 'Promises')
          .replace(/\bcall\s*backs?\b/gi, 'callbacks')
          .replace(/\basink\b/gi, 'async')
          .replace(/\ba\s*wait\b/gi, 'await')
          .replace(/\bcall\s*stack\b/gi, 'call stack')
          .replace(/\bevent\s*loop\b/gi, 'event loop')
          .replace(/\bhoisting\b/gi, 'hoisting');
      }

      polished = polished.charAt(0).toUpperCase() + polished.slice(1);
      if (!/[.!?]$/.test(polished)) {
        polished += '.';
      }

      return polished;
    }
  }

  let body = '';

  if (
    promptLower.includes('how does orvix work') ||
    promptLower.includes('what is orvix') ||
    promptLower.includes('features')
  ) {
    if (isConcise) {
      body = `**Orvix** is a high-performance multi-provider AI chat client.
• **AI Providers:** Gemini, Groq, OpenRouter, Cloudflare, WebLLM.
• **Capabilities:** Text streaming, document analysis, OCR, voice dictation.`;
    } else {
      body = `**Orvix** is a lightweight, responsive, and private AI chat workspace.

### Key Capabilities
1. **Multi-Provider Architecture:** Switch seamlessly between Google Gemini, Groq, OpenRouter, Cloudflare Workers AI, and Browser AI (WebLLM).
2. **Multimodal Attachments:** Upload PDFs, Office docs, code, and images with serverless OCR and vision grounding.
3. **Voice Dictation:** High-accuracy Whisper transcription with native Web Speech fallback.
4. **Offline Resilience:** IndexedDB local persistence and PWA support.`;
    }
  } else if (
    promptLower.includes('react') ||
    promptLower.includes('javascript') ||
    promptLower.includes('code') ||
    promptLower.includes('snippet')
  ) {
    if (isConcise) {
      body = `Here is a clean React state example:

\`\`\`jsx
import React, { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount((c) => c + 1)}>
      Count: {count}
    </button>
  );
}
\`\`\``;
    } else {
      body = `Here is a complete, production-ready React component:

\`\`\`jsx
import React, { useState, useCallback } from 'react';

export function InteractiveCounter({ initialValue = 0 }) {
  const [count, setCount] = useState(initialValue);

  const increment = useCallback(() => setCount((c) => c + 1), []);
  const decrement = useCallback(() => setCount((c) => c - 1), []);
  const reset = useCallback(() => setCount(initialValue), [initialValue]);

  return (
    <div className="flex items-center gap-3 p-4 bg-zinc-900 rounded-xl text-white">
      <span className="font-mono text-xl">{count}</span>
      <button onClick={decrement} className="px-3 py-1 bg-zinc-700 rounded">-</button>
      <button onClick={increment} className="px-3 py-1 bg-teal-600 rounded">+</button>
      <button onClick={reset} className="px-3 py-1 bg-zinc-800 rounded text-xs">Reset</button>
    </div>
  );
}
\`\`\`

• **State updates:** Messages are updated immutably in memory or synced to Firestore.
• **Responsive design:** Markdown blocks format with syntax highlights.`;
    }
  } else if (
    promptLower.includes('brainstorm') ||
    promptLower.includes('idea') ||
    promptLower.includes('startup') ||
    promptLower.includes('name')
  ) {
    if (isConcise) {
      body = `1. **NexusPulse** — Ambient async workspace.
2. **KiteFlow** — Low-friction drafting engine.
3. **OmniCanvas** — Unified notes & canvas.
4. **SpectraAI** — High-speed research layer.`;
    } else {
      body = `Here are 4 creative concepts for your consideration:
${isBeginner ? '\n*Each idea is framed around solving a practical everyday workflow obstacle:*\n' : ''}
1. **NexusPulse** — Ambient conversational workspace for asynchronous team synthesis.
2. **KiteFlow** — Low-friction, lightweight drafting engine for technical creators.
3. **OmniCanvas** — Multimodal canvas bringing notes, documents, and chat threads into one view.
4. **SpectraAI** — Precision intelligence layer tailored for high-speed research.

*Tip: You can select any conversation from the sidebar or click "+ New Chat" to start fresh.*`;
    }
  } else if (
    promptLower.includes('artificial intelligence') ||
    (promptLower.includes('ai') && (promptLower.includes('everyday') || promptLower.includes('real-world') || promptLower.includes('use') || promptLower.includes('table') || promptLower.includes('explain')))
  ) {
    if (isConcise) {
      body = `### Artificial Intelligence in Everyday Life

**Introduction:** Artificial Intelligence (AI) refers to computational systems that simulate human intelligence to learn from data, recognize patterns, and make automated decisions.

**5 Common Real-World Uses:**
1. **Virtual Assistants:** Voice agents like Siri and Alexa process natural speech to answer questions and trigger tasks.
2. **Recommendation Engines:** Streaming services (Netflix, Spotify) analyze consumption habits to suggest tailored content.
3. **Smart Navigation:** Apps like Google Maps calculate optimal routes using real-time traffic telemetry.
4. **Fraud Detection:** Financial systems monitor payment transactions in milliseconds to flag anomalous activity.
5. **Healthcare Imaging:** Pattern-recognition models assist clinicians in identifying abnormalities on medical scans.

**Comparison Table:**
| Characteristic | Traditional Software | Artificial Intelligence |
| :--- | :--- | :--- |
| **Decision Logic** | Explicit hardcoded IF/THEN rules | Probabilistic learning from training data |
| **Adaptability** | Fixed; requires manual code updates | Self-improves as fresh data arrives |
| **Edge Cases** | Halts or errors on unanticipated input | Infers closest probable resolution |

**Short Example:** Email spam filters dynamically classify messages based on sender reputational metrics, suspicious phrasing, and link patterns without requiring manual rule coding for every new spam campaign.

**Conclusion:** AI has become an everyday companion that enhances productivity and decision accuracy across digital workflows.`;
    } else {
      body = `### 1. Introduction: What is Artificial Intelligence?

**Artificial Intelligence (AI)** encompasses computer systems and algorithmic architectures engineered to simulate human cognitive capabilities—including empirical learning, contextual reasoning, natural language comprehension, and autonomous decision-making. Rather than relying solely on rigid, hard-coded procedures, modern AI systems utilize machine learning and neural networks to ingest large datasets, identify complex patterns, and refine their predictive performance over time.

---

### 2. Five Common Real-World Uses of AI in Everyday Life

1. **Virtual Personal Assistants & Voice Interfaces**
   *Everyday manifestation:* Apple Siri, Amazon Alexa, Google Assistant.
   *How it works:* Uses Automatic Speech Recognition (ASR) and Natural Language Understanding (NLU) to interpret vocal commands, manage calendars, operate smart home devices, and retrieve real-time information.

2. **Predictive Recommendation Engines**
   *Everyday manifestation:* Netflix, Spotify, YouTube, and Amazon.
   *How it works:* Employs collaborative filtering and deep retrieval models to evaluate historical user preferences, session length, and behavioral affinity matrices, surfacing highly relevant content tailored to individual tastes.

3. **Dynamic Navigation & Urban Mobility**
   *Everyday manifestation:* Google Maps, Waze, and ride-hailing services like Uber.
   *How it works:* Ingests crowdsourced GPS telemetry, historical transit speeds, and live incident reports to dynamically compute the most time-efficient routes and predict estimated arrival times (ETAs).

4. **Financial Fraud Prevention & Cybersecurity**
   *Everyday manifestation:* Real-time banking alerts and payment gateway defenses.
   *How it works:* Machine learning anomaly detection models evaluate millions of credit card transactions per second against established behavioral profiles, instantly blocking unauthorized purchases or suspicious geographical anomalies.

5. **Diagnostic Healthcare & Medical Imaging**
   *Everyday manifestation:* Computer-aided detection in radiology, ophthalmology, and pathology.
   *How it works:* High-resolution convolutional networks examine X-rays, MRIs, and retinal scans to detect early-stage indicators of disease—such as micro-fractures, tumors, or diabetic retinopathy—supporting physician diagnoses.

---

### 3. Comparison: Traditional Software vs. Artificial Intelligence

| Feature / Dimension | Traditional Software | Artificial Intelligence (AI) |
| :--- | :--- | :--- |
| **Operational Logic** | Predefined, deterministic \`IF/THEN\` conditional rules | Probabilistic patterns inferred from training datasets |
| **Adaptability** | Static; requires human developers to rewrite code | Dynamic; continuously learns and refines from new data |
| **Handling Ambiguity** | Halts, fails, or throws unhandled exceptions on edge cases | Gracefully infers probable outcomes from noisy or incomplete inputs |
| **Primary Strength** | Precise calculations, transactional ledger integrity, speed | Semantic understanding, perceptual recognition, and synthesis |
| **Development Paradigm** | Programmer writes explicit algorithms and specifications | Developer builds architectures and trains models on curated data |

---

### 4. Short Real-World Example: Email Spam Filtering

A prime example is the modern email spam filter (such as Gmail's or Outlook's). Instead of relying on a human programmer to maintain an exhaustive blacklist of every offensive word, an AI classification model analyzes incoming messages across hundreds of simultaneous dimensions: sender domain reputation, header anomalies, sentence embeddings, urgency phrasing, and link destinations. When millions of users mark a novel deceptive email as "Spam", the model automatically adjusts its weights within minutes, shielding users from emerging phishing tactics without any software update.

---

### 5. Conclusion

Artificial Intelligence has evolved from specialized computational research into an ambient foundation of modern daily life. By operating silently behind digital services—anticipating our travel needs, securing financial transactions, and filtering digital noise—AI functions not as a replacement for human agency, but as an indispensable cognitive amplifier that elevates everyday efficiency and decision-making.`;
    }
  } else if (
    promptLower.startsWith('hi') ||
    promptLower.startsWith('hello') ||
    promptLower.startsWith('hey')
  ) {
    if (isConcise) {
      body = `Hello${greetingName}! I'm **Orvix**. How can I help with writing, code, or ideas today?`;
    } else {
      body = `Hello${greetingName}! I am **Orvix**, your intelligent AI conversation companion.

${isBeginner ? "If you're new here, feel free to ask questions in plain English—no technical jargon required!\n\n" : ''}I can help you with:
• **Writing & Editing:** Craft essays, draft professional emails, and summarize reports.
• **Coding & Tech:** Debug React/Node code, explain architectures, and review syntax.
• **Brainstorming:** Generate fresh ideas, project names, and creative outlines.
• **Learning:** Break down complex topics simply and concisely.`;
    }
  } else {
    body = `Thank you for your prompt${personalSignoff}:
> "${promptText}"

${isBeginner ? 'I will explain everything simply and step-by-step. ' : ''}I am ready to assist with your questions, code samples, or writing projects. Feel free to ask more details or explore specific topics!`;
  }

  return body;
}

export function initSSE(res: express.Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

export function sendSSE(res: express.Response, data: object) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
  }
}

export function startSSEHeartbeat(res: express.Response, intervalMs = 10000): () => void {
  const timer = setInterval(() => {
    if (!res.writableEnded && !(res as any).destroyed) {
      try {
        res.write(':\n\n');
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch (_) {}
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

/**
 * Registers /api/chat, /chat, and root / POST endpoints on the Express application.
 */
export function registerChatRoutes(app: express.Express) {
  app.post(['/api/chat', '/chat', '/'], async (req, res) => {
    // Disable any artificial HTTP or socket timeouts for long-running AI streams
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true, 10000);
    }
    if (res.socket) {
      res.socket.setTimeout(0);
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true, 10000);
    }
    try {
      const {
        provider = 'gemini',
      model: clientModel,
      mode = 'general',
      prompt,
      history = [],
      username = null,
      preferences = null,
      stream = true,
      conversationId = null,
      attachments = [],
      isContinuation: clientIsContinuation,
      partNumber: clientPartNumber,
      originalPrompt: clientOriginalPrompt,
      previousContentSummary: clientPreviousContentSummary
    } = req.body as {
      provider?: string;
      model?: string;
      mode?: string;
      prompt?: string;
      history?: Array<{ sender?: string; content?: string; attachments?: any[] }>;
      username?: string | null;
      preferences?: UserPreferences | null;
      stream?: boolean;
      conversationId?: string | null;
      attachments?: any[];
      isContinuation?: boolean;
      partNumber?: number;
      originalPrompt?: string | null;
      previousContentSummary?: string | null;
    };

    if (!prompt || typeof prompt !== 'string') {
      logAIDiagnostic({
        category: 'request validation error',
        provider: String(req.body?.provider || 'unknown'),
        model: String(req.body?.model || 'unknown'),
        phase: 'validation',
        upstreamStatus: 400,
        sanitizedMessage: 'Prompt is required and must be a string.'
      });
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    // Resolve multi-part response context
    const multiPartCtx: any = resolveMultiPartContext(history, prompt);
    const isContinuation =
      typeof clientIsContinuation === 'boolean'
        ? clientIsContinuation
        : multiPartCtx.isContinuation;
    const partNumber = clientPartNumber || multiPartCtx.partNumber || 1;
    const originalPrompt = clientOriginalPrompt || multiPartCtx.originalPrompt || prompt;
    const previousContentSummary =
      clientPreviousContentSummary || multiPartCtx.previousContentSummary || '';

    // Request-scoped upstream cancellation & header timeout guard
    const upstreamGuard = createRequestUpstreamGuard(req, res);
    res.once('finish', () => upstreamGuard.cleanup());
    res.once('close', () => upstreamGuard.cleanup());

    // Phase 2C Secondary Bypass Protection:
    // If request contains attachments, verify authentication and server registry ownership.
    const authResult = await authenticateUploadRequest(req);
    const chatUserIdentity: VerifiedUserIdentity | null = authResult.success ? authResult.identity : null;

    if (Array.isArray(attachments) && attachments.length > 0) {
      if (!authResult.success) {
        upstreamGuard.cleanup();
        logAIDiagnostic({
          category: 'request validation error',
          provider: String(req.body?.provider || 'unknown'),
          model: String(req.body?.model || 'unknown'),
          phase: 'validation',
          upstreamStatus: authResult.status,
          upstreamErrorCode: authResult.code,
          sanitizedMessage: 'Authentication required to submit attachments to chat.'
        });
        return res.status(authResult.status).json({
          error: authResult.error || 'Authentication required to use attachments in chat.',
          code: authResult.code || 'AUTHENTICATION_REQUIRED',
          status: authResult.status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST'
        });
      }

      // Verify that every submitted attachment exists in fileRegistry and belongs to the verified user.
      for (const att of attachments) {
        const attId = att?.id || att?.fileId;
        if (!attId) {
          upstreamGuard.cleanup();
          return res.status(400).json({
            error: 'Attachment missing valid identifier.',
            code: 'INVALID_ATTACHMENT'
          });
        }
        const record = fileRegistry.get(attId);
        if (!record) {
          upstreamGuard.cleanup();
          return res.status(400).json({
            error: `Attachment '${attId}' was not found in the server registry. All attachments must be uploaded through the upload endpoint.`,
            code: 'UNVERIFIED_ATTACHMENT'
          });
        }
        if (record.userId && chatUserIdentity && record.userId !== chatUserIdentity.uid) {
          upstreamGuard.cleanup();
          return res.status(403).json({
            error: 'Access denied: attachment does not belong to the verified user.',
            code: 'ATTACHMENT_FORBIDDEN'
          });
        }
      }
    }

    // Validate target server provider & incoming model identifier
    let normalizedProvider = String(provider || 'gemini').trim().toLowerCase();
    if (normalizedProvider === 'ollama') {
      normalizedProvider = 'gemini';
    }
    const SERVER_SUPPORTED_PROVIDERS = new Set(['gemini', 'groq', 'openrouter', 'cloudflare']);
    if (!SERVER_SUPPORTED_PROVIDERS.has(normalizedProvider)) {
      upstreamGuard.cleanup();
      const errMessage =
        normalizedProvider === 'webllm'
          ? 'Browser AI (WebLLM) runs directly in the browser via WebGPU and cannot be dispatched to /api/chat.'
          : `Unknown provider: ${provider}`;
      logAIDiagnostic({
        category: 'request validation error',
        provider: normalizedProvider,
        model: String(clientModel || 'N/A'),
        phase: 'validation',
        upstreamStatus: 400,
        upstreamErrorCode: 'INVALID_ARGUMENT',
        sanitizedMessage: errMessage
      });
      return res.status(400).json({
        error: errMessage,
        code: 400,
        status: normalizedProvider === 'webllm' ? 'LOCAL_PROVIDER_ONLY' : 'INVALID_ARGUMENT',
        provider: normalizedProvider,
        retryable: false,
        canFallback: false
      });
    }

    const modelValidation = validateServerModelForProvider(normalizedProvider, clientModel);
    if (!modelValidation.valid) {
      upstreamGuard.cleanup();
      logAIDiagnostic({
        category: 'request validation error',
        provider: normalizedProvider,
        model: String(clientModel || 'invalid'),
        phase: 'validation',
        upstreamStatus: 400,
        upstreamErrorCode: 'INVALID_MODEL',
        sanitizedMessage: modelValidation.error || 'Invalid model identifier for provider.'
      });
      return res.status(400).json({
        error: modelValidation.error || 'Invalid model identifier for selected provider.',
        code: 400,
        status: 'INVALID_MODEL',
        errorCode: 'INVALID_MODEL',
        provider: normalizedProvider,
        retryable: false,
        canFallback: false
      });
    }
    const validatedClientModel: string | null = modelValidation.model;

    // Associate attachments sent in this turn with the conversation
    if (conversationId && Array.isArray(attachments)) {
      let docSet = conversationDocuments.get(conversationId);
      if (!docSet) {
        docSet = new Set<string>();
        conversationDocuments.set(conversationId, docSet);
      }
      for (const att of attachments) {
        const attId = att?.id || att?.fileId;
        if (attId) {
          docSet.add(attId);
          const existing = fileRegistry.get(attId);
          if (existing) {
            existing.conversationId = conversationId;
          }
        }
      }
    }

    const availableDocs: DocumentData[] = [];
    const seenDocIds = new Set<string>();

    const addDocIfValid = (docData: DocumentData, fromConvId?: string) => {
      if (fromConvId && conversationId && fromConvId !== conversationId) {
        return;
      }
      const docKey = docData.fileId || docData.id || (docData.originalName ? `${docData.originalName}_${docData.sizeBytes || 0}` : docData.filename);
      if (docKey && !seenDocIds.has(docKey)) {
        seenDocIds.add(docKey);
        availableDocs.push(docData);
      }
    };

    // 1. Current turn attachments (strictly server-registered records belonging to verified user)
    const currentTurnAttachmentId = Array.isArray(attachments) && attachments[0]?.id ? String(attachments[0].id) : undefined;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        const attId = att?.id || att?.fileId;
        if (!attId) continue;
        const record = fileRegistry.get(attId);
        if (!record) continue;
        if (record.userId && chatUserIdentity && record.userId !== chatUserIdentity.uid) continue;

        if (!record.extraction) {
          try {
            const ext = path.extname(record.diskFilename).toLowerCase();
            const isImg =
              ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif'].includes(ext) ||
              record.mimeType.startsWith('image/');
            const fullDiskPath = path.join(UPLOAD_DIR, record.diskFilename);
            const inputSource = record.buffer || (fs.existsSync(fullDiskPath) ? fullDiskPath : null);
            if (inputSource) {
              const isOfflineChat = Boolean(req.body?.offline);
              const geminiKey = getGeminiApiKey() || null;

              if (isImg) {
                record.extraction = (await extractImageText(
                  inputSource,
                  record.originalName,
                  ext,
                  record.mimeType,
                  record.id,
                  record.dimensions,
                  geminiKey,
                  { offline: isOfflineChat }
                )) as any;
                record.status = record.extraction?.status === 'error' ? 'error' : 'ready';
              } else {
                record.extraction = (await extractDocumentContent(
                  inputSource,
                  record.originalName,
                  ext,
                  record.mimeType,
                  record.id,
                  { offline: isOfflineChat, apiKey: geminiKey }
                )) as any;
              }
            }
          } catch (lazyErr) {
            console.warn('[Extraction] On-demand extraction error:', lazyErr);
            logAIDiagnostic({
              category: 'attachment/context processing failure',
              provider: String(req.body?.provider || 'unknown'),
              model: String(req.body?.model || 'unknown'),
              phase: 'attachment',
              sanitizedMessage: `Extraction failed for attachment: ${(lazyErr as Error)?.message || lazyErr}`
            });
          }
        }

        const rawExtraction = record.extraction;
        if (rawExtraction) {
          const originalName = record.originalName;
          const extName = path.extname(originalName).toLowerCase();
          const detectedFormat =
            (rawExtraction as any).format ||
            record.extension ||
            (extName === '.pdf' ? 'PDF' : extName === '.docx' ? 'DOCX' : extName === '.pptx' ? 'PPTX' : extName === '.txt' ? 'TXT' : undefined);

          const docData: DocumentData = {
            ...(rawExtraction as DocumentData),
            id: record.id,
            fileId: record.id,
            originalName,
            filename: record.diskFilename || originalName,
            format: detectedFormat || (rawExtraction as any).format,
            mimeType: record.mimeType,
            type: record.mimeType,
            sizeBytes: Number(record.size || 0),
            pages: (rawExtraction as any).pages || record.extraction?.pages,
            isImage: Boolean((rawExtraction as any).isImage || record.isImage)
          };
          addDocIfValid(docData, record.conversationId || conversationId || undefined);
        }
      }
    }

    // 2. Attachments in history of this conversation (strictly server-registered records belonging to verified user)
    if (Array.isArray(history)) {
      for (let i = history.length - 1; i >= 0; i--) {
        const hMsg = history[i];
        if (Array.isArray(hMsg?.attachments)) {
          for (const hAtt of hMsg.attachments) {
            const hId = hAtt?.id || hAtt?.fileId;
            if (!hId) continue;
            const record = fileRegistry.get(hId);
            if (record && (!chatUserIdentity || !record.userId || record.userId === chatUserIdentity.uid)) {
              if (record.extraction) {
                addDocIfValid(record.extraction as DocumentData, record.conversationId || conversationId || undefined);
              }
            }
          }
        }
      }
    }

    // 3. Conversation-registered files for this conversation
    if (conversationId && conversationDocuments.has(conversationId)) {
      const convSet = Array.from(conversationDocuments.get(conversationId)!).reverse();
      for (const fileId of convSet) {
        const record = fileRegistry.get(fileId);
        if (record && (!chatUserIdentity || !record.userId || record.userId === chatUserIdentity.uid)) {
          if (record.extraction) {
            addDocIfValid(record.extraction as DocumentData, record.conversationId || conversationId);
          }
        }
      }
    }

    // 4. Attachments referenced in the multi-part sequence
    if (isContinuation && Array.isArray(multiPartCtx.referencedAttachments)) {
      for (const rAtt of multiPartCtx.referencedAttachments) {
        const rId = rAtt?.id || rAtt?.fileId;
        if (!rId) continue;
        const record = fileRegistry.get(rId);
        if (record && (!chatUserIdentity || !record.userId || record.userId === chatUserIdentity.uid)) {
          if (record.extraction) {
            addDocIfValid(record.extraction as DocumentData, record.conversationId || conversationId || undefined);
          }
        }
      }
    }

    const effectiveDocPrompt = isContinuation && originalPrompt ? originalPrompt : prompt;
    const isVision = isVisionCapableProvider(
      normalizedProvider,
      validatedClientModel ?? undefined
    );
    const prepDoc: PreparedDocumentContext = prepareDocumentContext(effectiveDocPrompt, availableDocs, {
      provider: normalizedProvider,
      model: validatedClientModel ?? undefined,
      isVisionCapable: isVision,
      activeAttachmentId: currentTurnAttachmentId
    }) as PreparedDocumentContext;
    const shouldStream = stream !== false;

    const largeDetection = detectLargeResponseIntent({
      prompt: effectiveDocPrompt,
      docs: availableDocs,
      preferences,
      mode,
      history
    });
    const isLikelyLarge = largeDetection.isLikelyLarge || isContinuation;

    const multiPartAugmentation = buildMultiPartPromptAugmentation({
      isLikelyLarge,
      isContinuation,
      partNumber,
      originalPrompt: originalPrompt || prompt,
      previousContentSummary,
      provider: normalizedProvider
    });

    const isImageNoTextRejection =
      prepDoc.directAnswer === 'No readable text detected in this image.' ||
      (typeof prepDoc.directAnswer === 'string' &&
        prepDoc.directAnswer.toLowerCase().includes('no readable text detected') &&
        availableDocs.length > 0 &&
        availableDocs.every((d: any) => isImageAttachment(d)));

    if (prepDoc.directAnswer && !(isVision && isImageNoTextRejection)) {
      if (!shouldStream) {
        return res.json({
          text: prepDoc.directAnswer,
          modelUsed: 'Document Analyzer',
          provider: normalizedProvider
        });
      }
      initSSE(res);
      sendSSE(res, { type: 'start', modelUsed: 'Document Analyzer', provider: normalizedProvider });
      sendSSE(res, { type: 'chunk', text: prepDoc.directAnswer });
      sendSSE(res, { type: 'done', text: prepDoc.directAnswer, modelUsed: 'Document Analyzer', provider: normalizedProvider });
      res.end();
      return;
    }

    const cleanUsername =
      typeof username === 'string' && username.trim()
        ? username.trim().slice(0, 50).replace(/[\r\n\t]/g, ' ')
        : null;

    const baseSystemInstruction = buildSystemInstruction(cleanUsername, preferences, mode);
    const fullSystemInstruction = multiPartAugmentation
      ? `${baseSystemInstruction}\n\n${multiPartAugmentation}`
      : baseSystemInstruction;

    const adapted: any = adaptDocumentContextForProvider({
      provider: normalizedProvider,
      prompt,
      baseSystemInstruction: fullSystemInstruction,
      preparedContext: prepDoc
    });

    const effectiveSystemInstruction = adapted.effectiveSystemInstruction;
    const effectivePrompt = adapted.effectivePrompt;

    let validatedGeminiImageParts: Array<{ mimeType: string; data: string }> = [];
    if (normalizedProvider === 'gemini') {
      try {
        validatedGeminiImageParts = buildGeminiImageParts({
          attachments: Array.isArray(attachments) ? attachments : [],
          availableDocs
        });
      } catch (imgErr: any) {
        const statusCode = Number(imgErr?.code) === 413 ? 413 : 400;
        const statusLabel = statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_ARGUMENT';
        return res.status(statusCode).json({
          error:
            imgErr?.message ||
            'Attached image payload could not be processed within the supported request limits.',
          code: statusCode,
          status: statusLabel,
          provider: 'gemini',
          retryable: false,
          canFallback: false
        });
      }
    }

    const serializedBodyBytes = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
    if (serializedBodyBytes > MAX_CHAT_REQUEST_BYTES) {
      return res.status(413).json({
        error: `The complete chat request (${(serializedBodyBytes / (1024 * 1024)).toFixed(1)} MB) exceeds the ${(MAX_CHAT_REQUEST_BYTES / (1024 * 1024)).toFixed(1)} MB serverless request budget (max ${(MAX_VISION_IMAGE_BYTES / (1024 * 1024)).toFixed(1)} MB per image). Please resize or compress attached images or start a new conversation.`,
        code: 413,
        status: 'PAYLOAD_TOO_LARGE',
        provider: normalizedProvider,
        retryable: false,
        canFallback: false
      });
    }

    // 1. Google Gemini Provider
    if (normalizedProvider === 'gemini') {
      const apiKey = getGeminiApiKey();

      if (!isConfiguredCredential(apiKey)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'gemini', isServerless);
        }
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : `${GEMINI_PRIMARY_MODEL} (demo)`;
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'gemini',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'gemini', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'gemini', isDemo: true });
          res.end();
        }
        return;
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      const imageParts: Array<{ mimeType: string; data: string }> = validatedGeminiImageParts;
      const contents = formatGeminiHistory(history, effectivePrompt, 12, imageParts);
      const requestedGeminiModel = validatedClientModel || GEMINI_PRIMARY_MODEL;
      const fallbackCandidates = GEMINI_FALLBACK_CANDIDATES;
      const uniquePlanModels = [requestedGeminiModel];
      for (const cand of fallbackCandidates) {
        if (!uniquePlanModels.includes(cand)) {
          uniquePlanModels.push(cand);
        }
      }
      const attemptPlan = uniquePlanModels.map((m, idx) => ({
        model: m,
        attemptNum: idx + 1
      }));
      const maxAttempts = attemptPlan.length;

      let targetGeminiTokens = 4096;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        targetGeminiTokens = 8192;
      } else if (preferences?.responseLength === 'concise') {
        targetGeminiTokens = 1024;
      }

      const geminiRequestStartTime = Date.now();
      const totalRequestTimeoutMs = getGeminiTotalRequestTimeoutMs();

      logGeminiLifecycleEvent({
        event: 'request_start',
        elapsedMs: 0,
        httpStatus: null,
        model: requestedGeminiModel,
        chunkCount: 0,
        streamState: shouldStream ? 'sse_init' : 'unary_init',
        attempt: 1,
        maxAttempts
      });

      if (!shouldStream) {
        let lastParsedErr = null;

        for (let i = 0; i < attemptPlan.length; i++) {
          if (upstreamGuard.isClientClosed()) {
            logGeminiLifecycleEvent({
              event: 'client_disconnect',
              elapsedMs: Date.now() - geminiRequestStartTime,
              httpStatus: null,
              model: attemptPlan[i].model,
              chunkCount: 0,
              streamState: 'unary_aborted',
              attempt: attemptPlan[i].attemptNum,
              maxAttempts
            });
            return;
          }
          const { model, attemptNum } = attemptPlan[i];
          const hasMoreAttempts = i < attemptPlan.length - 1;
          const nextModel = hasMoreAttempts ? attemptPlan[i + 1]?.model : null;
          const isAdvancingToDistinctModel = Boolean(hasMoreAttempts && nextModel && nextModel !== model);

          try {
            logGeminiLifecycleEvent({
              event: 'upstream_fetch_start',
              elapsedMs: Date.now() - geminiRequestStartTime,
              httpStatus: null,
              model,
              chunkCount: 0,
              streamState: 'unary_fetching',
              attempt: attemptNum,
              maxAttempts
            });

            const unaryTimeoutMs = Math.max(
              1000,
              Math.min(
                getGeminiUnaryTimeoutMs(isAdvancingToDistinctModel),
                totalRequestTimeoutMs - (Date.now() - geminiRequestStartTime)
              )
            );

            const response = await upstreamGuard.callGeminiWithGuard(
              (signal) =>
                ai.models.generateContent({
                  model,
                  contents,
                  config: {
                    abortSignal: signal,
                    systemInstruction: effectiveSystemInstruction,
                    maxOutputTokens: targetGeminiTokens,
                    temperature: 0.7
                  }
                }),
              { provider: 'gemini', headersTimeoutMs: unaryTimeoutMs }
            );

            if (upstreamGuard.isClientClosed()) return;

            logGeminiLifecycleEvent({
              event: 'upstream_headers_received',
              elapsedMs: Date.now() - geminiRequestStartTime,
              httpStatus: 200,
              model,
              chunkCount: 1,
              streamState: 'unary_received',
              attempt: attemptNum,
              maxAttempts
            });

            const candidate = response?.candidates?.[0];
            const finishReason = candidate?.finishReason || (response as any)?.promptFeedback?.blockReason;

            if (finishReason === 'SAFETY' || (response as any)?.promptFeedback?.blockReason === 'SAFETY') {
              return res.status(400).json({
                error: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
                code: 400,
                status: 'SAFETY_BLOCKED',
                provider: 'gemini',
                model,
                retryable: false,
                canFallback: true,
                finishReason: 'SAFETY'
              });
            }

            let finalText = '';
            try {
              finalText = response?.text || '';
            } catch (textErr: any) {
              if (String(textErr?.message || '').toLowerCase().includes('safety')) {
                return res.status(400).json({
                  error: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
                  code: 400,
                  status: 'SAFETY_BLOCKED',
                  provider: 'gemini',
                  model,
                  retryable: false,
                  canFallback: true,
                  finishReason: 'SAFETY'
                });
              }
            }

            if (finalText) {
              logGeminiLifecycleEvent({
                event: 'upstream_complete',
                elapsedMs: Date.now() - geminiRequestStartTime,
                httpStatus: 200,
                model,
                chunkCount: 1,
                streamState: 'completed',
                attempt: attemptNum,
                maxAttempts,
                finishReason: finishReason || null
              });

              const isTruncated = finishReason === 'MAX_TOKENS';
              if ((isTruncated || isLikelyLarge) && !isContinuation && !responseHasContinuationNotice(finalText)) {
                finalText += CONTINUATION_NOTICES.PART_1;
              }
              return res.json({
                text: finalText,
                modelUsed: model,
                provider: 'gemini',
                ...(finishReason ? { finishReason } : {}),
                ...(isTruncated ? { truncated: true } : {})
              });
            }
          } catch (err: any) {
            if (upstreamGuard.isClientDisconnected(err)) {
              logGeminiLifecycleEvent({
                event: 'client_disconnect',
                elapsedMs: Date.now() - geminiRequestStartTime,
                httpStatus: null,
                model,
                chunkCount: 0,
                streamState: 'unary_aborted',
                attempt: attemptNum,
                maxAttempts
              });
              return;
            }
            const parsed = parseGeminiError(err, 'gemini');
            lastParsedErr = parsed;

            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const isTimeoutFailure = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
            const willAdvanceFallback = (isModelNotFound || isTimeoutFailure) && isAdvancingToDistinctModel;
            const remainingBudgetMs = totalRequestTimeoutMs - (Date.now() - geminiRequestStartTime);
            const willRetry =
              (parsed.isRetryable || willAdvanceFallback) &&
              hasMoreAttempts &&
              remainingBudgetMs > 5000 &&
              !upstreamGuard.isClientClosed() &&
              !(isServerless && isTimeoutFailure && !isAdvancingToDistinctModel);

            logGeminiLifecycleEvent({
              event: isTimeoutFailure ? 'timeout' : 'upstream_error',
              elapsedMs: Date.now() - geminiRequestStartTime,
              httpStatus: parsed.statusCode,
              model,
              chunkCount: 0,
              streamState: 'unary_error',
              attempt: attemptNum,
              maxAttempts,
              ...(isTimeoutFailure ? { timeoutStage: 'unary_timeout' as const } : {}),
              errorCode: parsed.status,
              willRetry
            });

            logAIDiagnostic({
              category: parsed.category,
              provider: 'gemini',
              model,
              phase: 'non-streaming',
              attempt: attemptNum,
              maxAttempts,
              upstreamStatus: parsed.statusCode,
              upstreamErrorCode: parsed.status,
              sanitizedMessage: parsed.message,
              retryAfterSeconds: parsed.retryAfterSeconds,
              willRetry
            });

            if (!parsed.isRetryable && !willAdvanceFallback) {
              return res.status(parsed.statusCode).json({
                error: parsed.message,
                code: parsed.statusCode,
                status: parsed.status,
                provider: 'gemini',
                model,
                retryable: false,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
              });
            }

            if (willRetry) {
              if (willAdvanceFallback) {
                continue;
              }
              const delay = getBackoffWithJitter(attemptNum, parsed.retryAfterSeconds);
              const continueExecution = await sleepWithAbort(delay, () => upstreamGuard.isClientClosed());
              if (!continueExecution) return;
              continue;
            }
            break;
          }
        }

        if (upstreamGuard.isClientClosed()) return;

        const fallbackErr = lastParsedErr || {
          statusCode: 503,
          status: 'UNAVAILABLE',
          message: 'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.',
          isRetryable: true
        };
        return res.status(fallbackErr.statusCode).json({
          error: fallbackErr.message,
          code: fallbackErr.statusCode,
          status: fallbackErr.status,
          provider: 'gemini',
          model: requestedGeminiModel,
          retryable: fallbackErr.isRetryable,
          serverRetriesExhausted: true,
          canFallback: true,
          suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
        });
      } else {
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res, 8000);
        res.write(': prime\n\n');
        res.flushHeaders?.();

        let lastParsedErr: any = null;
        let streamedAnyChunk = false;

        for (let i = 0; i < attemptPlan.length; i++) {
          if (upstreamGuard.isClientClosed() || res.writableEnded) {
            stopHeartbeat();
            logGeminiLifecycleEvent({
              event: 'client_disconnect',
              elapsedMs: Date.now() - geminiRequestStartTime,
              httpStatus: 200,
              model: attemptPlan[i].model,
              chunkCount: 0,
              streamState: 'aborted_before_attempt',
              attempt: attemptPlan[i].attemptNum,
              maxAttempts
            });
            return;
          }
          const { model, attemptNum } = attemptPlan[i];
          const hasMoreAttempts = i < attemptPlan.length - 1;
          const nextModel = hasMoreAttempts ? attemptPlan[i + 1]?.model : null;
          const isAdvancingToDistinctModel = Boolean(hasMoreAttempts && nextModel && nextModel !== model);
          let sentStartEvent = false;

          try {
            const streamResult = await consumeGeminiStreamWithWatchdog({
              invokeStream: (signal) =>
                ai.models.generateContentStream({
                  model,
                  contents,
                  config: {
                    abortSignal: signal,
                    systemInstruction: effectiveSystemInstruction,
                    maxOutputTokens: targetGeminiTokens,
                    temperature: 0.7
                  }
                }),
              model,
              attemptNum,
              maxAttempts,
              requestStartTime: geminiRequestStartTime,
              headerTimeoutMs: getGeminiHeaderTimeoutMs(isAdvancingToDistinctModel),
              firstByteTimeoutMs: getGeminiFirstByteTimeoutMs(),
              inactivityTimeoutMs: getGeminiStreamInactivityTimeoutMs(),
              totalRequestTimeoutMs,
              isClientClosed: () => upstreamGuard.isClientClosed() || res.writableEnded,
              registerController: (ctrl) => upstreamGuard.registerController(ctrl),
              unregisterController: (ctrl) => upstreamGuard.unregisterController(ctrl),
              onFirstChunk: () => {
                if (!sentStartEvent && !res.writableEnded) {
                  sendSSE(res, { type: 'start', modelUsed: model, provider: 'gemini' });
                  sentStartEvent = true;
                }
              },
              onChunk: (chunkText) => {
                streamedAnyChunk = true;
                if (!res.writableEnded) {
                  sendSSE(res, { type: 'chunk', text: chunkText });
                }
              }
            });

            stopHeartbeat();

            if (!upstreamGuard.isClientClosed() && !res.writableEnded) {
              const { fullText: rawFullText, lastFinishReason } = streamResult;
              let fullText = rawFullText;

              if (lastFinishReason === 'SAFETY' && fullText.trim().length === 0) {
                sendSSE(res, {
                  type: 'error',
                  error: "The response was blocked by Google Gemini's safety filters. Please rephrase your request.",
                  code: 400,
                  status: 'SAFETY_BLOCKED',
                  category: 'request validation error',
                  provider: 'gemini',
                  model,
                  retryable: false,
                  canFallback: false,
                  finishReason: 'SAFETY'
                });
                res.end();
                return;
              }

              if (!sentStartEvent) {
                sendSSE(res, { type: 'start', modelUsed: model, provider: 'gemini' });
                sentStartEvent = true;
              }

              const isTruncated = lastFinishReason === 'MAX_TOKENS';
              if ((isTruncated || isLikelyLarge) && !isContinuation && !responseHasContinuationNotice(fullText)) {
                sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
                fullText += CONTINUATION_NOTICES.PART_1;
              }
              sendSSE(res, {
                type: 'done',
                text: fullText,
                modelUsed: model,
                provider: 'gemini',
                ...(lastFinishReason ? { finishReason: lastFinishReason } : {}),
                ...(isTruncated ? { truncated: true } : {})
              });
              res.end();
            }
            return;
          } catch (attemptErr: any) {
            if (upstreamGuard.isClientDisconnected(attemptErr)) {
              stopHeartbeat();
              return;
            }

            const attemptStreamedAny = Boolean(streamedAnyChunk || attemptErr?.streamedAnyChunk);

            if (attemptStreamedAny) {
              stopHeartbeat();
              const parsed = parseGeminiError(attemptErr, 'gemini');
              logAIDiagnostic({
                category: 'streaming failure',
                provider: 'gemini',
                model,
                phase: 'mid-stream',
                attempt: attemptNum,
                maxAttempts,
                upstreamStatus: parsed.statusCode,
                upstreamErrorCode: parsed.status,
                sanitizedMessage: parsed.message
              });

              if (!res.writableEnded) {
                sendSSE(res, {
                  type: 'error',
                  error: parsed.message,
                  code: parsed.statusCode,
                  status: parsed.status,
                  category: parsed.category,
                  provider: 'gemini',
                  model,
                  retryable: false,
                  canFallback: false,
                  partial: true
                });
                res.end();
              }
              return;
            }

            const parsed = parseGeminiError(attemptErr, 'gemini');
            lastParsedErr = parsed;

            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const isTimeoutFailure = parsed.statusCode === 504 || parsed.status === 'DEADLINE_EXCEEDED';
            const willAdvanceFallback = (isModelNotFound || isTimeoutFailure) && isAdvancingToDistinctModel;
            const remainingBudgetMs = totalRequestTimeoutMs - (Date.now() - geminiRequestStartTime);
            const willRetry =
              (parsed.isRetryable || willAdvanceFallback) &&
              hasMoreAttempts &&
              remainingBudgetMs > 5000 &&
              !upstreamGuard.isClientClosed() &&
              !(isServerless && isTimeoutFailure && !isAdvancingToDistinctModel);

            logGeminiLifecycleEvent({
              event: 'upstream_error',
              elapsedMs: Date.now() - geminiRequestStartTime,
              httpStatus: parsed.statusCode,
              model,
              chunkCount: 0,
              streamState: 'pre_stream_error',
              attempt: attemptNum,
              maxAttempts,
              errorCode: parsed.status,
              willRetry
            });

            logAIDiagnostic({
              category: parsed.category,
              provider: 'gemini',
              model,
              phase: 'pre-stream',
              attempt: attemptNum,
              maxAttempts,
              upstreamStatus: parsed.statusCode,
              upstreamErrorCode: parsed.status,
              sanitizedMessage: parsed.message,
              retryAfterSeconds: parsed.retryAfterSeconds,
              willRetry
            });

            if (!parsed.isRetryable && !willAdvanceFallback) {
              stopHeartbeat();
              if (!res.writableEnded) {
                sendSSE(res, {
                  type: 'error',
                  error: parsed.message,
                  code: parsed.statusCode,
                  status: parsed.status,
                  category: parsed.category,
                  provider: 'gemini',
                  model,
                  retryable: false,
                  canFallback: parsed.statusCode !== 400 && parsed.statusCode !== 413,
                  suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
                });
                res.end();
              }
              return;
            }

            if (willRetry) {
              if (willAdvanceFallback) {
                continue;
              }
              const delay = getBackoffWithJitter(attemptNum, parsed.retryAfterSeconds);
              const continueExecution = await sleepWithAbort(delay, () => upstreamGuard.isClientClosed());
              if (!continueExecution) {
                stopHeartbeat();
                return;
              }
              continue;
            }
            break;
          }
        }

        stopHeartbeat();
        if (upstreamGuard.isClientClosed()) return;

        const finalErr = lastParsedErr || {
          statusCode: 503,
          status: 'UNAVAILABLE',
          category: 'provider API error' as const,
          message: 'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.',
          isRetryable: true
        };

        if (!res.writableEnded) {
          sendSSE(res, {
            type: 'error',
            error: finalErr.message,
            code: finalErr.statusCode,
            status: finalErr.status,
            category: finalErr.category,
            provider: 'gemini',
            model: requestedGeminiModel,
            retryable: false,
            serverRetriesExhausted: true,
            canFallback: finalErr.statusCode !== 400 && finalErr.statusCode !== 413,
            suggestedProviders: getConfiguredFallbackProviders('gemini', isServerless)
          });
          res.end();
        }
        return;
      }
    }

    // 2. Groq Provider
    if (normalizedProvider === 'groq') {
      const apiKey = getGroqApiKey();
      if (!isConfiguredCredential(apiKey)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'groq', isServerless);
        }
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'GPT OSS 120B (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'groq',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'groq', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'groq', isDemo: true });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const GROQ_ACTIVE_MODEL = 'openai/gpt-oss-120b';
      const requestedGroqModel = validatedClientModel || GROQ_ACTIVE_MODEL;
      const groqFallbackCandidates: string[] = Array.isArray(GROQ_FALLBACK_CHAT_MODELS)
        ? [...GROQ_FALLBACK_CHAT_MODELS]
        : ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'];
      const uniqueGroqPlanModels = [requestedGroqModel];
      for (const cand of groqFallbackCandidates) {
        if (!uniqueGroqPlanModels.includes(cand)) {
          uniqueGroqPlanModels.push(cand);
        }
      }
      const groqAttemptPlan = uniqueGroqPlanModels.map((m, idx) => ({
        model: m,
        attemptNum: idx + 1
      }));
      const groqChatEndpoint = `${getGroqApiBaseUrl()}/chat/completions`;

      let groqMaxTokens = 2560;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        groqMaxTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        groqMaxTokens = 1024;
      }

      if (!shouldStream) {
        let lastParsedErr: any = null;
        let lastFailedModel = requestedGroqModel;

        for (let i = 0; i < groqAttemptPlan.length; i++) {
          if (upstreamGuard.isClientClosed()) return;
          const { model: currentModel, attemptNum } = groqAttemptPlan[i];
          lastFailedModel = currentModel;

          try {
            const groqRes = await upstreamGuard.fetchUpstream(
              groqChatEndpoint,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: currentModel,
                  messages,
                  max_tokens: groqMaxTokens,
                  temperature: 0.7
                })
              },
              { provider: 'groq' }
            );

            if (!groqRes.ok) {
              const errText = await groqRes.text();
              const parsed = parseGeminiError({ status: groqRes.status, message: errText }, 'groq');
              let friendlyError = parsed.message;
              if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
                friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
              }
              lastParsedErr = { ...parsed, message: friendlyError };

              const hasMoreAttempts = i < groqAttemptPlan.length - 1;
              const isModelNotFound = groqRes.status === 404 || parsed.status === 'NOT_FOUND';
              const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

              logAIDiagnostic({
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                phase: 'non-streaming',
                attempt: attemptNum,
                upstreamStatus: groqRes.status,
                sanitizedMessage: friendlyError
              });

              if (willAdvanceFallback) {
                continue;
              }

              return res.status(groqRes.status).json({
                error: friendlyError,
                code: groqRes.status,
                status: parsed.status,
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                retryable: parsed.isRetryable,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
              });
            }

            const data = await groqRes.json();
            if (upstreamGuard.isClientClosed()) return;
            let finalText = data?.choices?.[0]?.message?.content || '';
            const finishReason = data?.choices?.[0]?.finish_reason;

            if (finishReason === 'length' && finalText.length > 60 && !upstreamGuard.isClientClosed()) {
              try {
                const contMessages = [
                  ...messages,
                  { role: 'assistant', content: finalText },
                  { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
                ];
                const contRes = await upstreamGuard.fetchUpstream(
                  groqChatEndpoint,
                  {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${apiKey}`,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      model: currentModel,
                      messages: contMessages,
                      max_tokens: Math.min(2048, groqMaxTokens),
                      temperature: 0.7
                    })
                  },
                  { provider: 'groq' }
                );
                if (contRes.ok) {
                  const contData = await contRes.json();
                  const contText = contData?.choices?.[0]?.message?.content;
                  if (contText) {
                    finalText += (finalText.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                  }
                }
              } catch (_) {}
            }

            if (upstreamGuard.isClientClosed()) return;
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
              finalText += CONTINUATION_NOTICES.PART_1;
            }
            return res.json({
              text: finalText,
              modelUsed: data.model || currentModel,
              provider: 'groq'
            });
          } catch (fetchErr: any) {
            if (upstreamGuard.isClientDisconnected(fetchErr)) {
              return;
            }
            const parsed = parseGeminiError(fetchErr, 'groq');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < groqAttemptPlan.length - 1;
            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

            logAIDiagnostic({
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              phase: 'non-streaming',
              attempt: attemptNum,
              upstreamStatus: parsed.statusCode,
              sanitizedMessage: parsed.message
            });

            if (willAdvanceFallback) {
              continue;
            }

            return res.status(parsed.statusCode).json({
              error: parsed.message,
              code: parsed.statusCode,
              status: parsed.status,
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              retryable: parsed.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
            });
          }
        }

        if (upstreamGuard.isClientClosed()) return;

        const fallbackErr = lastParsedErr || {
          statusCode: 404,
          status: 'NOT_FOUND',
          message: 'The requested Groq model was not found and all fallback options were exhausted.',
          isRetryable: false
        };
        return res.status(fallbackErr.statusCode).json({
          error: fallbackErr.message,
          code: fallbackErr.statusCode,
          status: fallbackErr.status,
          provider: 'groq',
          model: lastFailedModel,
          retryable: false,
          serverRetriesExhausted: true,
          canFallback: true,
          suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
        });
      } else {
        let groqRes: Response | null = null;
        let selectedModel = requestedGroqModel;
        let lastParsedErr: any = null;

        for (let i = 0; i < groqAttemptPlan.length; i++) {
          if (upstreamGuard.isClientClosed()) return;
          const { model: currentModel, attemptNum } = groqAttemptPlan[i];
          selectedModel = currentModel;

          try {
            const attemptRes = await upstreamGuard.fetchUpstream(
              groqChatEndpoint,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: currentModel,
                  messages,
                  max_tokens: groqMaxTokens,
                  temperature: 0.7,
                  stream: true
                })
              },
              { provider: 'groq' }
            );

            if (!attemptRes.ok) {
              const errText = await attemptRes.text();
              const parsed = parseGeminiError({ status: attemptRes.status, message: errText }, 'groq');
              let friendlyError = parsed.message;
              if (errText.includes('context_length_exceeded') || errText.includes('maximum context length') || errText.includes('tokens')) {
                friendlyError = 'The attached document exceeds Groq\'s context length limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.';
              }
              lastParsedErr = { ...parsed, message: friendlyError };

              const hasMoreAttempts = i < groqAttemptPlan.length - 1;
              const isModelNotFound = attemptRes.status === 404 || parsed.status === 'NOT_FOUND';
              const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

              logAIDiagnostic({
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                phase: 'pre-stream',
                attempt: attemptNum,
                upstreamStatus: attemptRes.status,
                sanitizedMessage: friendlyError
              });

              if (willAdvanceFallback) {
                continue;
              }

              return res.status(attemptRes.status).json({
                error: friendlyError,
                code: attemptRes.status,
                status: parsed.status,
                category: parsed.category,
                provider: 'groq',
                model: currentModel,
                retryable: parsed.isRetryable,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
              });
            }

            groqRes = attemptRes;
            break;
          } catch (fetchErr: any) {
            if (upstreamGuard.isClientDisconnected(fetchErr)) {
              return;
            }
            const parsed = parseGeminiError(fetchErr, 'groq');
            lastParsedErr = parsed;
            const hasMoreAttempts = i < groqAttemptPlan.length - 1;
            const isModelNotFound = parsed.statusCode === 404 || parsed.status === 'NOT_FOUND';
            const willAdvanceFallback = isModelNotFound && hasMoreAttempts;

            logAIDiagnostic({
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              phase: 'pre-stream',
              attempt: attemptNum,
              upstreamStatus: parsed.statusCode,
              sanitizedMessage: parsed.message
            });

            if (willAdvanceFallback) {
              continue;
            }

            return res.status(parsed.statusCode).json({
              error: parsed.message,
              code: parsed.statusCode,
              status: parsed.status,
              category: parsed.category,
              provider: 'groq',
              model: currentModel,
              retryable: parsed.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
            });
          }
        }

        if (!groqRes) {
          if (upstreamGuard.isClientClosed()) return;
          const fallbackErr = lastParsedErr || {
            statusCode: 404,
            status: 'NOT_FOUND',
            message: 'The requested Groq model was not found and all fallback options were exhausted.',
            isRetryable: false
          };
          return res.status(fallbackErr.statusCode).json({
            error: fallbackErr.message,
            code: fallbackErr.statusCode,
            status: fallbackErr.status,
            provider: 'groq',
            model: selectedModel,
            retryable: false,
            serverRetriesExhausted: true,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('groq', isServerless)
          });
        }

        if (upstreamGuard.isClientClosed()) return;
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: selectedModel, provider: 'groq' });

        let fullText = '';
        try {
          const reader = groqRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let modelUsed = selectedModel;
          let lastFinishReason: string | null = null;
          let currentEventType: string | null = null;
          let streamFailed = false;

          const emitGroqStreamError = async (rawDataStr: string, explicitErrObj?: any) => {
            if (streamFailed) return;
            streamFailed = true;

            let parsedErrMessage = 'Groq streaming connection encountered an upstream error.';
            let rawErrCode = 0;
            let rawErrType = '';

            const extractFromErrorField = (errVal: any) => {
              if (typeof errVal === 'string' && errVal.trim()) {
                parsedErrMessage = errVal.trim();
              } else if (errVal && typeof errVal === 'object') {
                if (typeof errVal.message === 'string' && errVal.message.trim()) {
                  parsedErrMessage = errVal.message.trim();
                } else if (typeof errVal.error === 'string' && errVal.error.trim()) {
                  parsedErrMessage = errVal.error.trim();
                }
                const numCode = Number(errVal.code ?? errVal.status ?? errVal.statusCode);
                if (Number.isFinite(numCode) && numCode >= 400 && numCode < 600) {
                  rawErrCode = numCode;
                }
                if (typeof errVal.type === 'string' && errVal.type.trim()) {
                  rawErrType = errVal.type.trim();
                } else if (typeof errVal.status === 'string' && errVal.status.trim()) {
                  rawErrType = errVal.status.trim();
                } else if (typeof errVal.code === 'string' && errVal.code.trim()) {
                  rawErrType = errVal.code.trim();
                }
              }
            };

            if (explicitErrObj !== undefined) {
              extractFromErrorField(explicitErrObj);
            } else if (rawDataStr) {
              try {
                const errJson = JSON.parse(rawDataStr);
                extractFromErrorField(errJson?.error ?? errJson);
              } catch (_) {
                const cleaned = rawDataStr
                  .replace(/<[^>]*>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 280);
                if (cleaned) {
                  parsedErrMessage = cleaned;
                }
              }
            }

            if (!rawErrCode) {
              if (/rate_limit|429|quota|too many requests/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 429;
              } else if (/auth|401|invalid_api_key/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 401;
              } else if (/permission|403/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 403;
              } else if (/not_found|404|model_not_found/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 404;
              } else {
                rawErrCode = 500;
              }
            }

            const effectiveStatus = rawErrType || (rawErrCode === 429 ? 'RESOURCE_EXHAUSTED' : 'STREAM_ERROR');

            stopHeartbeat();
            try { await reader.cancel(); } catch (_) {}
            logAIDiagnostic({
              category: 'streaming failure',
              provider: 'groq',
              model: modelUsed || selectedModel,
              phase: 'mid-stream',
              upstreamStatus: rawErrCode,
              sanitizedMessage: parsedErrMessage
            });

            if (!upstreamGuard.isClientClosed() && !res.writableEnded) {
              sendSSE(res, {
                type: 'error',
                error: parsedErrMessage,
                code: rawErrCode,
                status: effectiveStatus,
                provider: 'groq',
                model: modelUsed || selectedModel,
                retryable: false,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('groq', isServerless),
                partial: fullText.length > 0,
                partialText: fullText.length > 0 ? fullText : undefined
              });
              res.end();
            }
          };

          const processGroqSSELine = async (line: string): Promise<boolean> => {
            const trimmed = line.trim();
            if (!trimmed) {
              currentEventType = null;
              return false;
            }
            if (trimmed.startsWith(':')) return false;

            if (trimmed.startsWith('event:')) {
              currentEventType = trimmed.slice(6).trim().toLowerCase();
              return false;
            }

            if (!trimmed.startsWith('data:')) return false;
            const eventTypeForLine = currentEventType;
            currentEventType = null;

            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') return false;

            if (eventTypeForLine === 'error') {
              await emitGroqStreamError(dataStr);
              return true;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed && typeof parsed === 'object' && parsed.error) {
                await emitGroqStreamError(dataStr, parsed.error);
                return true;
              }

              if (parsed.model) modelUsed = parsed.model;
              const finishReason = parsed?.choices?.[0]?.finish_reason;
              if (finishReason) lastFinishReason = finishReason;
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {
              if (/"error"\s*:/.test(dataStr)) {
                await emitGroqStreamError(dataStr);
                return true;
              }
            }
            return false;
          };

          while (true) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }
            const { done, value } = await reader.read();
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const haltedOnError = await processGroqSSELine(line);
              if (haltedOnError) return;
            }
          }

          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (!streamFailed && !upstreamGuard.isClientClosed() && buffer && buffer.trim()) {
            const remainingLines = buffer.split('\n');
            for (const line of remainingLines) {
              const haltedOnError = await processGroqSSELine(line);
              if (haltedOnError) return;
            }
            if (!streamFailed && currentEventType === 'error') {
              await emitGroqStreamError(buffer.trim());
              return;
            }
          }

          if (!streamFailed && (lastFinishReason === 'length' || lastFinishReason === 'max_tokens') && !upstreamGuard.isClientClosed() && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                groqChatEndpoint,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    model: selectedModel,
                    messages: contMessages,
                    max_tokens: Math.min(2048, groqMaxTokens),
                    temperature: 0.7,
                    stream: true
                  })
                },
                { provider: 'groq' }
              );

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                let contEventType: string | null = null;
                while (true) {
                  if (upstreamGuard.isClientClosed() || res.writableEnded) {
                    try { await contReader.cancel(); } catch (_) {}
                    break;
                  }
                  const { done: cDone, value: cVal } = await contReader.read();
                  if (cDone) break;
                  contBuffer += decoder.decode(cVal, { stream: true });
                  const cLines = contBuffer.split('\n');
                  contBuffer = cLines.pop() || '';
                  for (const cLine of cLines) {
                    const cTrimmed = cLine.trim();
                    if (!cTrimmed) {
                      contEventType = null;
                      continue;
                    }
                    if (cTrimmed.startsWith(':')) continue;
                    if (cTrimmed.startsWith('event:')) {
                      contEventType = cTrimmed.slice(6).trim().toLowerCase();
                      continue;
                    }
                    if (!cTrimmed.startsWith('data:')) continue;
                    const lineEvt = contEventType;
                    contEventType = null;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;

                    if (lineEvt === 'error') {
                      try { await contReader.cancel(); } catch (_) {}
                      break;
                    }

                    try {
                      const cParsed = JSON.parse(cData);
                      if (cParsed.error) {
                        try { await contReader.cancel(); } catch (_) {}
                        break;
                      }
                      const cDelta = cParsed?.choices?.[0]?.delta?.content;
                      if (cDelta) {
                        fullText += cDelta;
                        sendSSE(res, { type: 'chunk', text: cDelta });
                      }
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }

          stopHeartbeat();
          if (!streamFailed && !upstreamGuard.isClientClosed() && !res.writableEnded) {
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'groq' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          stopHeartbeat();
          if (upstreamGuard.isClientDisconnected(streamErr)) {
            return;
          }
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'groq',
            model: selectedModel,
            phase: 'mid-stream',
            sanitizedMessage: streamErr?.message || 'Groq stream read interrupted'
          });
          if (!res.writableEnded) {
            sendSSE(res, {
              type: 'error',
              error: 'Groq streaming connection interrupted.',
              code: 503,
              status: 'STREAM_FAILED',
              provider: 'groq',
              model: selectedModel,
              retryable: false,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('groq', isServerless),
              partial: fullText.length > 0,
              partialText: fullText.length > 0 ? fullText : undefined
            });
            res.end();
          }
          return;
        }
      }
    }

    // 3. OpenRouter Provider
    if (normalizedProvider === 'openrouter') {
      const apiKey = getOpenRouterApiKey();
      if (!isConfiguredCredential(apiKey)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'openrouter', isServerless);
        }
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'openrouter/free (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'openrouter',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'openrouter', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'openrouter', isDemo: true });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const selectedModel = validatedClientModel || 'openrouter/free';
      const openRouterChatEndpoint = `${getOpenRouterApiBaseUrl()}/chat/completions`;
      const openRouterHeaders = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://orvix.ai',
        'X-Title': 'Orvix'
      };

      const normalizeOpenRouterHttpError = (statusCode: number, errText: string) => {
        const parsed = parseGeminiError({ status: statusCode, message: errText }, 'openrouter');
        let friendlyError = parsed.message;
        let status = parsed.status;
        let isRetryable = parsed.isRetryable;
        let category = parsed.category;

        if (statusCode === 502) {
          status = 'BAD_GATEWAY';
          isRetryable = true;
          category = 'provider API error';
        } else if (statusCode === 500) {
          status = 'INTERNAL';
          isRetryable = true;
          category = 'provider API error';
        } else if (statusCode === 402) {
          status = 'PAYMENT_REQUIRED';
          isRetryable = false;
          category = 'provider configuration error';
        }

        const lowerErr = String(errText || '').toLowerCase();
        if (
          lowerErr.includes('context_length_exceeded') ||
          lowerErr.includes('maximum context length') ||
          (statusCode === 400 && (lowerErr.includes('too large') || lowerErr.includes('context length')))
        ) {
          friendlyError =
            "The attached document exceeds OpenRouter's context limit. Please switch to Google Gemini (which supports 1M tokens) or ask about specific pages or slides.";
          isRetryable = false;
        }

        return {
          statusCode,
          status,
          errorCode: status,
          category,
          isRetryable,
          message: friendlyError
        };
      };

      let openRouterMaxTokens = 2560;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        openRouterMaxTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        openRouterMaxTokens = 1024;
      }

      if (!shouldStream) {
        try {
          const orRes = await upstreamGuard.fetchUpstream(
            openRouterChatEndpoint,
            {
              method: 'POST',
              headers: openRouterHeaders,
              body: JSON.stringify({
                model: selectedModel,
                messages,
                max_tokens: openRouterMaxTokens,
                temperature: 0.7,
                stream: false
              })
            },
            { provider: 'openrouter' }
          );

          if (!orRes.ok) {
            const errText = await orRes.text();
            const normErr = normalizeOpenRouterHttpError(orRes.status, errText);
            logAIDiagnostic({
              category: normErr.category,
              provider: 'openrouter',
              model: selectedModel,
              phase: 'non-streaming',
              upstreamStatus: orRes.status,
              upstreamErrorCode: normErr.errorCode,
              sanitizedMessage: normErr.message
            });
            return res.status(orRes.status).json({
              error: normErr.message,
              code: orRes.status,
              status: normErr.status,
              errorCode: normErr.errorCode,
              category: normErr.category,
              provider: 'openrouter',
              model: selectedModel,
              retryable: normErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
            });
          }

          const data = await orRes.json();
          if (upstreamGuard.isClientClosed()) return;
          if (data?.error) {
            const embeddedCode = Number(data.error.code) || 502;
            const normErr = normalizeOpenRouterHttpError(
              embeddedCode >= 400 && embeddedCode < 600 ? embeddedCode : 502,
              JSON.stringify(data)
            );
            return res.status(normErr.statusCode).json({
              error: normErr.message,
              code: normErr.statusCode,
              status: normErr.status,
              errorCode: normErr.errorCode,
              category: normErr.category,
              provider: 'openrouter',
              model: selectedModel,
              retryable: normErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
            });
          }
          let finalText = data?.choices?.[0]?.message?.content || '';
          const finishReason = data?.choices?.[0]?.finish_reason;

          if (finishReason === 'length' && finalText.length > 60 && !upstreamGuard.isClientClosed()) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: finalText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                openRouterChatEndpoint,
                {
                  method: 'POST',
                  headers: openRouterHeaders,
                  body: JSON.stringify({
                    model: selectedModel,
                    messages: contMessages,
                    max_tokens: Math.min(2048, openRouterMaxTokens),
                    temperature: 0.7
                  })
                },
                { provider: 'openrouter' }
              );
              if (contRes.ok) {
                const contData = await contRes.json();
                const contText = contData?.choices?.[0]?.message?.content;
                if (contText) {
                  finalText += (finalText.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                }
              }
            } catch (_) {}
          }

          if (upstreamGuard.isClientClosed()) return;
          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(finalText)) {
            finalText += CONTINUATION_NOTICES.PART_1;
          }
          return res.json({
            text: finalText,
            modelUsed: data.model || selectedModel,
            provider: 'openrouter'
          });
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
          const parsed = parseGeminiError(fetchErr, 'openrouter');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'non-streaming',
            upstreamStatus: parsed.statusCode,
            upstreamErrorCode: parsed.status,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
          });
        }
      } else {
        let orRes: Response;
        try {
          orRes = await upstreamGuard.fetchUpstream(
            openRouterChatEndpoint,
            {
              method: 'POST',
              headers: openRouterHeaders,
              body: JSON.stringify({
                model: selectedModel,
                messages,
                max_tokens: openRouterMaxTokens,
                temperature: 0.7,
                stream: true
              })
            },
            { provider: 'openrouter' }
          );
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
          const parsed = parseGeminiError(fetchErr, 'openrouter');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: parsed.statusCode,
            upstreamErrorCode: parsed.status,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
          });
        }

        if (!orRes.ok) {
          const errText = await orRes.text();
          const normErr = normalizeOpenRouterHttpError(orRes.status, errText);
          logAIDiagnostic({
            category: normErr.category,
            provider: 'openrouter',
            model: selectedModel,
            phase: 'pre-stream',
            upstreamStatus: orRes.status,
            upstreamErrorCode: normErr.errorCode,
            sanitizedMessage: normErr.message
          });
          return res.status(orRes.status).json({
            error: normErr.message,
            code: orRes.status,
            status: normErr.status,
            errorCode: normErr.errorCode,
            category: normErr.category,
            provider: 'openrouter',
            model: selectedModel,
            retryable: normErr.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless)
          });
        }

        if (upstreamGuard.isClientClosed()) return;
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: selectedModel, provider: 'openrouter' });

        let fullText = '';
        let modelUsed = selectedModel;
        let streamFailed = false;

        try {
          const reader = orRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let lastFinishReason: string | null = null;
          let currentEventType: string | null = null;
          let sawDoneMarker = false;

          const emitOpenRouterStreamError = async (rawDataStr: string, explicitErrObj?: any) => {
            if (streamFailed) return;
            streamFailed = true;

            let parsedErrMessage = 'OpenRouter streaming connection encountered an upstream error.';
            let rawErrCode = 0;
            let rawErrType = '';

            const extractFromErrorField = (errVal: any) => {
              if (typeof errVal === 'string' && errVal.trim()) {
                parsedErrMessage = errVal.trim();
              } else if (errVal && typeof errVal === 'object') {
                if (typeof errVal.message === 'string' && errVal.message.trim()) {
                  parsedErrMessage = errVal.message.trim();
                } else if (typeof errVal.error === 'string' && errVal.error.trim()) {
                  parsedErrMessage = errVal.error.trim();
                }
                if (
                  typeof errVal.metadata?.raw === 'string' &&
                  errVal.metadata.raw.trim() &&
                  (!parsedErrMessage || parsedErrMessage.toLowerCase() === 'provider returned error')
                ) {
                  parsedErrMessage = `${parsedErrMessage}: ${errVal.metadata.raw.trim().slice(0, 200)}`;
                }
                const numCode = Number(errVal.code ?? errVal.status ?? errVal.statusCode);
                if (Number.isFinite(numCode) && numCode >= 400 && numCode < 600) {
                  rawErrCode = numCode;
                }
                if (typeof errVal.type === 'string' && errVal.type.trim()) {
                  rawErrType = errVal.type.trim();
                } else if (typeof errVal.status === 'string' && errVal.status.trim()) {
                  rawErrType = errVal.status.trim();
                } else if (typeof errVal.code === 'string' && errVal.code.trim()) {
                  rawErrType = errVal.code.trim();
                }
              }
            };

            if (explicitErrObj !== undefined) {
              extractFromErrorField(explicitErrObj);
            } else if (rawDataStr) {
              try {
                const errJson = JSON.parse(rawDataStr);
                extractFromErrorField(errJson?.error ?? errJson);
              } catch (_) {
                const cleaned = rawDataStr
                  .replace(/<[^>]*>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 280);
                if (cleaned) {
                  parsedErrMessage = cleaned;
                }
              }
            }

            if (!rawErrCode) {
              if (/rate_limit|429|quota|too many requests/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 429;
              } else if (/auth|401|invalid_api_key/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 401;
              } else if (/payment|402|credits/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 402;
              } else if (/permission|403/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 403;
              } else if (/not_found|404|model_not_found/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 404;
              } else if (/502|bad gateway|malformed/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 502;
              } else if (/503|unavailable|overloaded|interrupted/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 503;
              } else if (/504|timeout|timed out/i.test(`${rawErrType} ${parsedErrMessage}`)) {
                rawErrCode = 504;
              } else {
                rawErrCode = 500;
              }
            }

            const effectiveStatus =
              rawErrType ||
              (rawErrCode === 429
                ? 'RESOURCE_EXHAUSTED'
                : rawErrCode === 401
                ? 'UNAUTHENTICATED'
                : rawErrCode === 402
                ? 'PAYMENT_REQUIRED'
                : rawErrCode === 403
                ? 'PERMISSION_DENIED'
                : rawErrCode === 404
                ? 'NOT_FOUND'
                : rawErrCode === 502
                ? 'BAD_GATEWAY'
                : rawErrCode === 503
                ? 'UNAVAILABLE'
                : rawErrCode === 504
                ? 'DEADLINE_EXCEEDED'
                : 'STREAM_ERROR');

            stopHeartbeat();
            try {
              await reader.cancel();
            } catch (_) {}
            logAIDiagnostic({
              category: 'streaming failure',
              provider: 'openrouter',
              model: modelUsed || selectedModel,
              phase: 'mid-stream',
              upstreamStatus: rawErrCode,
              upstreamErrorCode: effectiveStatus,
              sanitizedMessage: parsedErrMessage
            });

            if (!upstreamGuard.isClientClosed() && !res.writableEnded) {
              sendSSE(res, {
                type: 'error',
                error: parsedErrMessage,
                code: rawErrCode,
                status: effectiveStatus,
                errorCode: effectiveStatus,
                provider: 'openrouter',
                model: modelUsed || selectedModel,
                retryable: false,
                canFallback: true,
                suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless),
                partial: fullText.length > 0,
                partialText: fullText.length > 0 ? fullText : undefined
              });
              res.end();
            }
          };

          const processOpenRouterSSELine = async (line: string): Promise<boolean> => {
            const trimmed = line.trim();
            if (!trimmed) {
              currentEventType = null;
              return false;
            }
            if (trimmed.startsWith(':')) return false;

            if (trimmed.startsWith('event:')) {
              currentEventType = trimmed.slice(6).trim().toLowerCase();
              return false;
            }

            if (!trimmed.startsWith('data:')) {
              if (currentEventType === 'error' || /"error"\s*:|<html|bad gateway|service unavailable/i.test(trimmed)) {
                await emitOpenRouterStreamError(trimmed);
                return true;
              }
              return false;
            }

            const eventTypeForLine = currentEventType;
            currentEventType = null;

            const dataStr = trimmed.slice(5).trim();
            if (!dataStr) return false;
            if (dataStr === '[DONE]') {
              sawDoneMarker = true;
              return false;
            }

            if (eventTypeForLine === 'error') {
              await emitOpenRouterStreamError(dataStr);
              return true;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed && typeof parsed === 'object' && parsed.error) {
                await emitOpenRouterStreamError(dataStr, parsed.error);
                return true;
              }

              if (parsed.model) modelUsed = parsed.model;
              const finishReason = parsed?.choices?.[0]?.finish_reason;
              if (finishReason === 'error') {
                await emitOpenRouterStreamError(dataStr, {
                  message: 'OpenRouter upstream provider terminated stream with finish_reason: error.',
                  code: 502,
                  type: 'UPSTREAM_STREAM_ERROR'
                });
                return true;
              }
              if (finishReason) lastFinishReason = finishReason;

              const delta = parsed?.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: 'chunk', text: delta });
              }
            } catch (_) {
              await emitOpenRouterStreamError(
                dataStr,
                /"error"\s*:/.test(dataStr)
                  ? undefined
                  : {
                      message: `Malformed SSE data frame received from OpenRouter: ${dataStr.slice(0, 180)}`,
                      code: 502,
                      type: 'MALFORMED_STREAM_FRAME'
                    }
              );
              return true;
            }
            return false;
          };

          while (true) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            const { done, value } = await reader.read();
            if (upstreamGuard.isClientClosed() || res.writableEnded) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const haltedOnError = await processOpenRouterSSELine(line);
              if (haltedOnError) return;
            }
          }

          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (!streamFailed && !upstreamGuard.isClientClosed() && buffer && buffer.trim()) {
            const remainingLines = buffer.split('\n');
            for (const line of remainingLines) {
              const haltedOnError = await processOpenRouterSSELine(line);
              if (haltedOnError) return;
            }
            if (!streamFailed && currentEventType === 'error') {
              await emitOpenRouterStreamError(buffer.trim());
              return;
            }
          }

          if (!streamFailed && !upstreamGuard.isClientClosed()) {
            if (!sawDoneMarker && !lastFinishReason) {
              await emitOpenRouterStreamError('', {
                message: 'OpenRouter streaming connection closed unexpectedly before completion.',
                code: 503,
                type: 'STREAM_INTERRUPTED'
              });
              return;
            }
            if (fullText.length === 0) {
              await emitOpenRouterStreamError('', {
                message: 'OpenRouter stream completed without returning any response text.',
                code: 502,
                type: 'EMPTY_STREAM_RESPONSE'
              });
              return;
            }
          }

          if (!streamFailed && (lastFinishReason === 'length' || lastFinishReason === 'max_tokens') && !upstreamGuard.isClientClosed() && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                openRouterChatEndpoint,
                {
                  method: 'POST',
                  headers: openRouterHeaders,
                  body: JSON.stringify({
                    model: selectedModel,
                    messages: contMessages,
                    max_tokens: Math.min(2048, openRouterMaxTokens),
                    temperature: 0.7,
                    stream: true
                  })
                },
                { provider: 'openrouter' }
              );

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                let contEventType: string | null = null;
                while (true) {
                  if (upstreamGuard.isClientClosed() || res.writableEnded) {
                    try {
                      await contReader.cancel();
                    } catch (_) {}
                    break;
                  }
                  const { done: cDone, value: cVal } = await contReader.read();
                  if (cDone) break;
                  contBuffer += decoder.decode(cVal, { stream: true });
                  const cLines = contBuffer.split('\n');
                  contBuffer = cLines.pop() || '';
                  for (const cLine of cLines) {
                    const cTrimmed = cLine.trim();
                    if (!cTrimmed) {
                      contEventType = null;
                      continue;
                    }
                    if (cTrimmed.startsWith(':')) continue;
                    if (cTrimmed.startsWith('event:')) {
                      contEventType = cTrimmed.slice(6).trim().toLowerCase();
                      continue;
                    }
                    if (!cTrimmed.startsWith('data:')) continue;
                    const lineEvt = contEventType;
                    contEventType = null;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;
                    if (lineEvt === 'error') {
                      try {
                        await contReader.cancel();
                      } catch (_) {}
                      break;
                    }
                    try {
                      const cParsed = JSON.parse(cData);
                      if (cParsed.error) {
                        try {
                          await contReader.cancel();
                        } catch (_) {}
                        break;
                      }
                      const cDelta = cParsed?.choices?.[0]?.delta?.content;
                      if (cDelta) {
                        fullText += cDelta;
                        sendSSE(res, { type: 'chunk', text: cDelta });
                      }
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }

          stopHeartbeat();
          if (!streamFailed && !upstreamGuard.isClientClosed() && !res.writableEnded) {
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed, provider: 'openrouter' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          stopHeartbeat();
          if (streamFailed || upstreamGuard.isClientDisconnected(streamErr)) {
            return;
          }
          streamFailed = true;
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'openrouter',
            model: modelUsed || selectedModel,
            phase: 'mid-stream',
            upstreamStatus: 503,
            upstreamErrorCode: 'STREAM_FAILED',
            sanitizedMessage: streamErr?.message || 'OpenRouter streaming interrupted'
          });
          if (!res.writableEnded) {
            sendSSE(res, {
              type: 'error',
              error: 'OpenRouter streaming connection interrupted.',
              code: 503,
              status: 'STREAM_FAILED',
              errorCode: 'STREAM_FAILED',
              provider: 'openrouter',
              model: modelUsed || selectedModel,
              retryable: false,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('openrouter', isServerless),
              partial: fullText.length > 0,
              partialText: fullText.length > 0 ? fullText : undefined
            });
            res.end();
          }
          return;
        }
      }
    }

    // 4. Cloudflare Workers AI Provider (@cf/meta/llama-3.1-8b-instruct)
    if (normalizedProvider === 'cloudflare') {
      const { accountId, apiToken } = getCloudflareCredentials();
      const modelId = validatedClientModel || '@cf/meta/llama-3.1-8b-instruct';

      if (!isConfiguredCredential(accountId) || !isConfiguredCredential(apiToken)) {
        if (!isDemoModeEnabled()) {
          return sendProviderNotConfiguredError(res, 'cloudflare', isServerless);
        }
        const text = (isLikelyLarge || isContinuation)
          ? generateSimulatedMultiPartResponse({
              prompt,
              docs: availableDocs,
              username: cleanUsername,
              preferences,
              mode,
              isContinuation,
              partNumber,
              originalPrompt
            })
          : availableDocs.length > 0
          ? generateSimulatedDocumentResponse(prompt, prepDoc)
          : generateSimulatedResponse(prompt, cleanUsername, preferences, mode);
        const demoModel = availableDocs.length > 0 ? 'Document Analyzer (demo)' : 'Cloudflare Workers AI — Llama 3.1 8B (demo)';
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: demoModel,
            provider: 'cloudflare',
            isDemo: true
          });
        }
        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: demoModel, provider: 'cloudflare', isDemo: true });

        const testDurationMatch = typeof prompt === 'string' ? prompt.match(/__test_stream_duration:(\d+)__/) : null;
        const testDurationSec = testDurationMatch
          ? parseInt(testDurationMatch[1], 10)
          : ((req.body as any)?.testStreamDurationSec ? Number((req.body as any).testStreamDurationSec) : null);

        if (testDurationSec && testDurationSec > 0) {
          const totalMs = testDurationSec * 1000;
          const tokens = text.split(/(\s+)/);
          const intervalMs = Math.max(80, Math.floor(totalMs / Math.max(tokens.length, 1)));
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(intervalMs, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        } else {
          const tokens = text.split(/(\s+)/);
          for (const token of tokens) {
            if (upstreamGuard.isClientClosed() || res.writableEnded) break;
            sendSSE(res, { type: 'chunk', text: token });
            await sleepWithAbort(15, () => upstreamGuard.isClientClosed() || res.writableEnded);
          }
        }

        stopHeartbeat();
        if (!res.writableEnded) {
          sendSSE(res, { type: 'done', text, modelUsed: demoModel, provider: 'cloudflare', isDemo: true });
          res.end();
        }
        return;
      }

      const messages = formatOpenAIMessages({
        systemInstruction: effectiveSystemInstruction,
        history,
        prompt: effectivePrompt
      });

      const estimatedPromptTokens = Math.ceil(JSON.stringify(messages).length / 3.8);
      const maxContextTokens = 8192;
      if (estimatedPromptTokens >= maxContextTokens - 128) {
        const contextErrMsg = `Prompt is too large for the Cloudflare model context window (estimated ${estimatedPromptTokens} tokens, limit ${maxContextTokens}). Please shorten your message or start a new conversation.`;
        logAIDiagnostic({
          category: 'request validation error',
          provider: 'cloudflare',
          model: modelId,
          phase: shouldStream ? 'pre-stream' : 'non-streaming',
          upstreamStatus: 400,
          sanitizedMessage: contextErrMsg
        });
        return res.status(400).json({
          error: contextErrMsg,
          code: 400,
          status: 'CONTEXT_LENGTH_EXCEEDED',
          errorCode: 'CONTEXT_LENGTH_EXCEEDED',
          category: 'invalid request / model',
          provider: 'cloudflare',
          model: modelId,
          retryable: false,
          canFallback: true,
          suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
        });
      }

      const availableTokenHeadroom = Math.max(256, maxContextTokens - estimatedPromptTokens - 256);

      let targetOutputTokens = 3072;
      if (preferences?.responseLength === 'detailed' || isLikelyLarge || isContinuation) {
        targetOutputTokens = 4096;
      } else if (preferences?.responseLength === 'concise') {
        targetOutputTokens = 1024;
      } else if (preferences?.responseLength === 'balanced') {
        targetOutputTokens = 2560;
      }

      const cfMaxTokens = Math.min(targetOutputTokens, availableTokenHeadroom);
      const cfEndpoint = `${getCloudflareApiBaseUrl()}/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;

      const normalizeCloudflareHttpError = (statusCode: number, errDetail: string) => {
        const lowerDetail = (errDetail || '').toLowerCase();
        const isContextLimit =
          (statusCode === 400 || statusCode === 413) &&
          (lowerDetail.includes('context length') ||
            lowerDetail.includes('context window') ||
            lowerDetail.includes('too many tokens') ||
            lowerDetail.includes('maximum context') ||
            lowerDetail.includes('prompt is too long') ||
            lowerDetail.includes('exceeds maximum') ||
            lowerDetail.includes('max_tokens'));

        if (isContextLimit) {
          return {
            status: 'CONTEXT_LENGTH_EXCEEDED',
            errorCode: 'CONTEXT_LENGTH_EXCEEDED',
            category: 'request validation error' as AIDiagnosticCategory,
            isRetryable: false,
            friendlyError: 'Prompt exceeds the Cloudflare model context window. Please shorten your message or clear older conversation turns.'
          };
        }

        const parsed = parseGeminiError({ status: statusCode, message: errDetail || `HTTP ${statusCode}` }, 'cloudflare');
        let friendlyError = parsed.message;
        let status = parsed.status;
        let isRetryable = parsed.isRetryable;

        if (statusCode === 401 || statusCode === 403) {
          friendlyError = 'Invalid or unauthorized Cloudflare API token. Please verify CLOUDFLARE_API_TOKEN.';
          status = statusCode === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED';
          isRetryable = false;
        } else if (statusCode === 404) {
          friendlyError = 'Cloudflare account or model not found. Please verify CLOUDFLARE_ACCOUNT_ID and model availability.';
          status = 'NOT_FOUND';
          isRetryable = false;
        } else if (statusCode === 400) {
          status = 'INVALID_ARGUMENT';
          isRetryable = false;
        } else if (statusCode === 429) {
          status = 'RESOURCE_EXHAUSTED';
          isRetryable = true;
        } else if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
          isRetryable = true;
          if (statusCode === 500) status = 'INTERNAL';
          else if (statusCode === 502) status = 'BAD_GATEWAY';
          else if (statusCode === 503) status = 'UNAVAILABLE';
          else if (statusCode === 504) status = 'DEADLINE_EXCEEDED';
        }

        return {
          status,
          errorCode: status,
          category: parsed.category,
          isRetryable,
          friendlyError
        };
      };

      if (!shouldStream) {
        try {
          const cfRes = await upstreamGuard.fetchUpstream(
            cfEndpoint,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                messages,
                stream: false,
                max_tokens: cfMaxTokens,
                temperature: 0.6
              })
            },
            { provider: 'cloudflare' }
          );

          if (!cfRes.ok) {
            let errDetail = '';
            try {
              const errJson = await cfRes.json();
              if (Array.isArray(errJson?.errors) && errJson.errors.length > 0) {
                errDetail = errJson.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ');
              } else if (errJson?.error) {
                errDetail = typeof errJson.error === 'string' ? errJson.error : errJson.error.message;
              }
            } catch (_) {
              errDetail = await cfRes.text();
            }

            const normalizedErr = normalizeCloudflareHttpError(cfRes.status, errDetail || cfRes.statusText);

            logAIDiagnostic({
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              phase: 'non-streaming',
              upstreamStatus: cfRes.status,
              sanitizedMessage: normalizedErr.friendlyError
            });

            return res.status(cfRes.status).json({
              error: normalizedErr.friendlyError,
              code: cfRes.status,
              status: normalizedErr.status,
              errorCode: normalizedErr.errorCode,
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              retryable: normalizedErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          let data: any;
          try {
            data = await cfRes.json();
          } catch (_) {
            return res.status(502).json({
              error: 'Cloudflare returned an invalid JSON response.',
              code: 502,
              status: 'MALFORMED_UPSTREAM_RESPONSE',
              errorCode: 'MALFORMED_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          if (upstreamGuard.isClientClosed()) return;

          if (data?.success === false || (Array.isArray(data?.errors) && data.errors.length > 0)) {
            const errMsg = Array.isArray(data?.errors) && data.errors.length > 0
              ? data.errors.map((e: any) => e?.message || JSON.stringify(e)).join('; ')
              : (typeof data?.error === 'string' ? data.error : 'Cloudflare Workers AI reported an upstream failure.');
            const normalizedErr = normalizeCloudflareHttpError(502, errMsg);
            return res.status(502).json({
              error: normalizedErr.friendlyError,
              code: 502,
              status: normalizedErr.status,
              errorCode: normalizedErr.errorCode,
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              retryable: normalizedErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          let text =
            data?.result?.response ??
            data?.choices?.[0]?.message?.content ??
            (typeof data?.result === 'string' ? data.result : '') ??
            '';
          if (typeof text !== 'string') {
            text = String(text || '');
          }

          if (!text.trim()) {
            return res.status(502).json({
              error: 'Cloudflare Workers AI returned an empty response.',
              code: 502,
              status: 'EMPTY_UPSTREAM_RESPONSE',
              errorCode: 'EMPTY_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          const finishReason = data?.result?.finish_reason || data?.choices?.[0]?.finish_reason || (data?.result?.usage?.completion_tokens >= cfMaxTokens ? 'length' : null);

          if (finishReason === 'length' && text.length > 60 && !upstreamGuard.isClientClosed()) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: text },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                cfEndpoint,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    messages: contMessages,
                    stream: false,
                    max_tokens: Math.min(2048, cfMaxTokens),
                    temperature: 0.6
                  })
                },
                { provider: 'cloudflare' }
              );
              if (contRes.ok) {
                const contData = await contRes.json();
                const contText = contData?.result?.response || (typeof contData?.result === 'string' ? contData.result : '');
                if (contText) {
                  text += (text.endsWith(' ') || contText.startsWith(' ') ? '' : ' ') + contText;
                }
              }
            } catch (_) {}
          }

          if (upstreamGuard.isClientClosed()) return;
          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(text)) {
            text += CONTINUATION_NOTICES.PART_1;
          }
          return res.json({
            text,
            modelUsed: modelId,
            provider: 'cloudflare'
          });
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
          const parsed = parseGeminiError(fetchErr, 'cloudflare');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            phase: 'non-streaming',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
          });
        }
      } else {
        let cfRes: Response;
        try {
          cfRes = await upstreamGuard.fetchUpstream(
            cfEndpoint,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                messages,
                stream: true,
                max_tokens: cfMaxTokens,
                temperature: 0.6
              })
            },
            { provider: 'cloudflare' }
          );
        } catch (fetchErr: any) {
          if (upstreamGuard.isClientDisconnected(fetchErr)) {
            return;
          }
          const parsed = parseGeminiError(fetchErr, 'cloudflare');
          logAIDiagnostic({
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            phase: 'pre-stream',
            upstreamStatus: parsed.statusCode,
            sanitizedMessage: parsed.message
          });
          return res.status(parsed.statusCode).json({
            error: parsed.message,
            code: parsed.statusCode,
            status: parsed.status,
            errorCode: parsed.status,
            category: parsed.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: parsed.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
          });
        }

        if (!cfRes.ok) {
          let errDetail = '';
          try {
            const errJson = await cfRes.json();
            if (Array.isArray(errJson?.errors) && errJson.errors.length > 0) {
              errDetail = errJson.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ');
            } else if (errJson?.error) {
              errDetail = typeof errJson.error === 'string' ? errJson.error : errJson.error.message;
            }
          } catch (_) {
            errDetail = await cfRes.text();
          }

          const normalizedErr = normalizeCloudflareHttpError(cfRes.status, errDetail || cfRes.statusText);

          logAIDiagnostic({
            category: normalizedErr.category,
            provider: 'cloudflare',
            model: modelId,
            phase: 'pre-stream',
            upstreamStatus: cfRes.status,
            sanitizedMessage: normalizedErr.friendlyError
          });

          return res.status(cfRes.status).json({
            error: normalizedErr.friendlyError,
            code: cfRes.status,
            status: normalizedErr.status,
            errorCode: normalizedErr.errorCode,
            category: normalizedErr.category,
            provider: 'cloudflare',
            model: modelId,
            retryable: normalizedErr.isRetryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
          });
        }

        if (upstreamGuard.isClientClosed()) return;
        const contentType = cfRes.headers.get('content-type') || '';

        if (contentType.includes('application/json') || !cfRes.body) {
          let data: any;
          try {
            data = await cfRes.json();
          } catch (_) {
            return res.status(502).json({
              error: 'Cloudflare returned an invalid JSON response.',
              code: 502,
              status: 'MALFORMED_UPSTREAM_RESPONSE',
              errorCode: 'MALFORMED_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          if (upstreamGuard.isClientClosed()) return;

          if (data?.success === false || (Array.isArray(data?.errors) && data.errors.length > 0)) {
            const errMsg = Array.isArray(data?.errors) && data.errors.length > 0
              ? data.errors.map((e: any) => e?.message || JSON.stringify(e)).join('; ')
              : (typeof data?.error === 'string' ? data.error : 'Cloudflare Workers AI reported an upstream failure.');
            const normalizedErr = normalizeCloudflareHttpError(502, errMsg);
            return res.status(502).json({
              error: normalizedErr.friendlyError,
              code: 502,
              status: normalizedErr.status,
              errorCode: normalizedErr.errorCode,
              category: normalizedErr.category,
              provider: 'cloudflare',
              model: modelId,
              retryable: normalizedErr.isRetryable,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          let fullText =
            data?.result?.response ??
            data?.choices?.[0]?.message?.content ??
            (typeof data?.result === 'string' ? data.result : '') ??
            '';
          if (typeof fullText !== 'string') {
            fullText = String(fullText || '');
          }

          if (!fullText.trim()) {
            return res.status(502).json({
              error: 'Cloudflare Workers AI returned an empty response.',
              code: 502,
              status: 'EMPTY_UPSTREAM_RESPONSE',
              errorCode: 'EMPTY_UPSTREAM_RESPONSE',
              category: 'upstream unavailable',
              provider: 'cloudflare',
              model: modelId,
              retryable: true,
              canFallback: true,
              suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless)
            });
          }

          if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
            fullText += CONTINUATION_NOTICES.PART_1;
          }
          initSSE(res);
          sendSSE(res, { type: 'start', modelUsed: modelId, provider: 'cloudflare' });
          sendSSE(res, { type: 'chunk', text: fullText });
          sendSSE(res, { type: 'done', text: fullText, modelUsed: modelId, provider: 'cloudflare' });
          res.end();
          return;
        }

        initSSE(res);
        const stopHeartbeat = startSSEHeartbeat(res);
        sendSSE(res, { type: 'start', modelUsed: modelId, provider: 'cloudflare' });

        let fullText = '';
        let lastFinishReason: string | null = null;
        let sawDoneSentinel = false;
        let sawErrorEvent = false;
        let streamFailed = false;

        const emitCloudflareStreamError = (
          errMessage: string,
          status = 'STREAM_FAILED',
          code = 502,
          retryable = false
        ) => {
          if (streamFailed || upstreamGuard.isClientClosed() || res.writableEnded) return;
          streamFailed = true;
          stopHeartbeat();
          logAIDiagnostic({
            category: 'streaming failure',
            provider: 'cloudflare',
            model: modelId,
            phase: 'mid-stream',
            upstreamStatus: code,
            sanitizedMessage: errMessage
          });
          sendSSE(res, {
            type: 'error',
            error: errMessage,
            code,
            status,
            errorCode: status,
            provider: 'cloudflare',
            model: modelId,
            retryable,
            canFallback: true,
            suggestedProviders: getConfiguredFallbackProviders('cloudflare', isServerless),
            partial: fullText.length > 0,
            ...(fullText.length > 0 ? { partialText: fullText } : {})
          });
          res.end();
        };

        const processCloudflareSSELine = (rawLine: string): boolean => {
          const trimmed = rawLine.trim();
          if (!trimmed) {
            sawErrorEvent = false;
            return true;
          }
          if (trimmed.startsWith(':')) {
            return true;
          }
          if (trimmed.startsWith('event:')) {
            const eventType = trimmed.slice(6).trim().toLowerCase();
            sawErrorEvent = eventType === 'error';
            return true;
          }
          if (!trimmed.startsWith('data:')) {
            return true;
          }

          const dataStr = trimmed.slice(5).trim();
          if (!dataStr) return true;
          if (dataStr === '[DONE]') {
            sawDoneSentinel = true;
            return true;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(dataStr);
          } catch (_) {
            emitCloudflareStreamError(
              'Malformed SSE data frame received from Cloudflare stream.',
              'MALFORMED_STREAM_FRAME',
              502,
              false
            );
            return false;
          }

          if (
            sawErrorEvent ||
            parsed?.error ||
            (Array.isArray(parsed?.errors) && parsed.errors.length > 0) ||
            parsed?.success === false
          ) {
            const upstreamErrMsg =
              typeof parsed?.error === 'string'
                ? parsed.error
                : parsed?.error?.message ||
                  (Array.isArray(parsed?.errors) && parsed.errors[0]?.message) ||
                  'Cloudflare Workers AI reported an error during streaming.';
            emitCloudflareStreamError(upstreamErrMsg, 'UPSTREAM_STREAM_ERROR', 502, false);
            return false;
          }

          const finishReason =
            parsed?.finish_reason ??
            parsed?.result?.finish_reason ??
            parsed?.choices?.[0]?.finish_reason ??
            null;
          if (finishReason) {
            lastFinishReason = finishReason;
            if (String(finishReason).toLowerCase() === 'error') {
              emitCloudflareStreamError(
                'Cloudflare stream terminated with finish_reason=error.',
                'STREAM_FINISH_ERROR',
                502,
                false
              );
              return false;
            }
          }

          const delta =
            parsed?.response ??
            parsed?.result?.response ??
            parsed?.choices?.[0]?.delta?.content ??
            '';
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            sendSSE(res, { type: 'chunk', text: delta });
          }

          return true;
        };

        try {
          const reader = cfRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            if (upstreamGuard.isClientClosed() || res.writableEnded || streamFailed) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            const { done, value } = await reader.read();
            if (upstreamGuard.isClientClosed() || res.writableEnded || streamFailed) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const ok = processCloudflareSSELine(line);
              if (!ok) return;
            }
          }

          const finalBytes = decoder.decode();
          if (finalBytes) buffer += finalBytes;
          if (!streamFailed && !upstreamGuard.isClientClosed() && buffer && buffer.trim()) {
            const remainingLines = buffer.split('\n');
            for (const line of remainingLines) {
              const ok = processCloudflareSSELine(line);
              if (!ok) return;
            }
          }

          if (!streamFailed && !upstreamGuard.isClientClosed()) {
            if (!sawDoneSentinel && !lastFinishReason) {
              emitCloudflareStreamError(
                'Cloudflare streaming connection closed unexpectedly before completion.',
                'STREAM_INTERRUPTED',
                503,
                false
              );
              return;
            }
            if (fullText.length === 0) {
              emitCloudflareStreamError(
                'Cloudflare stream completed without returning any response text.',
                'EMPTY_STREAM_RESPONSE',
                502,
                false
              );
              return;
            }
          }

          if (!streamFailed && (lastFinishReason === 'length' || lastFinishReason === 'max_tokens') && !upstreamGuard.isClientClosed() && !res.writableEnded && fullText.length > 60) {
            try {
              const contMessages = [
                ...messages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: 'Please continue directly from where you stopped. Complete any unfinished sentences, items, or sections without repeating previous text.' }
              ];
              const contRes = await upstreamGuard.fetchUpstream(
                cfEndpoint,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    messages: contMessages,
                    stream: true,
                    max_tokens: Math.min(2048, cfMaxTokens),
                    temperature: 0.6
                  })
                },
                { provider: 'cloudflare' }
              );

              if (contRes.ok && contRes.body) {
                const contReader = contRes.body.getReader();
                let contBuffer = '';
                while (true) {
                  if (upstreamGuard.isClientClosed() || res.writableEnded) {
                    try {
                      await contReader.cancel();
                    } catch (_) {}
                    break;
                  }
                  const { done: cDone, value: cVal } = await contReader.read();
                  if (cDone) break;
                  contBuffer += decoder.decode(cVal, { stream: true });
                  const cLines = contBuffer.split('\n');
                  contBuffer = cLines.pop() || '';
                  for (const cLine of cLines) {
                    const cTrimmed = cLine.trim();
                    if (!cTrimmed || cTrimmed.startsWith(':') || cTrimmed.startsWith('event:')) continue;
                    if (!cTrimmed.startsWith('data:')) continue;
                    const cData = cTrimmed.slice(5).trim();
                    if (cData === '[DONE]') continue;
                    try {
                      const cParsed = JSON.parse(cData);
                      if (cParsed.error) {
                        try {
                          await contReader.cancel();
                        } catch (_) {}
                        break;
                      }
                      const cDelta =
                        cParsed?.response ??
                        cParsed?.result?.response ??
                        cParsed?.choices?.[0]?.delta?.content ??
                        '';
                      if (typeof cDelta === 'string' && cDelta.length > 0) {
                        fullText += cDelta;
                        sendSSE(res, { type: 'chunk', text: cDelta });
                      }
                    } catch (_) {}
                  }
                }
              }
            } catch (_) {}
          }

          stopHeartbeat();
          if (!streamFailed && !upstreamGuard.isClientClosed() && !res.writableEnded) {
            if (isLikelyLarge && !isContinuation && !responseHasContinuationNotice(fullText)) {
              sendSSE(res, { type: 'chunk', text: CONTINUATION_NOTICES.PART_1 });
              fullText += CONTINUATION_NOTICES.PART_1;
            }
            sendSSE(res, { type: 'done', text: fullText, modelUsed: modelId, provider: 'cloudflare' });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          stopHeartbeat();
          if (upstreamGuard.isClientDisconnected(streamErr)) {
            return;
          }
          emitCloudflareStreamError(
            'Cloudflare streaming connection interrupted.',
            'STREAM_FAILED',
            503,
            false
          );
          return;
        }
      }
    }

    if (provider.toLowerCase() === 'webllm') {
      logAIDiagnostic({
        category: 'request validation error',
        provider: 'webllm',
        phase: 'validation',
        upstreamStatus: 400,
        upstreamErrorCode: 'LOCAL_PROVIDER_ONLY',
        sanitizedMessage: 'Browser AI (WebLLM) runs on-device in the browser via WebGPU and cannot be dispatched to the server-side /api/chat endpoint.',
        willRetry: false
      });
      return res.status(400).json({
        error: 'Browser AI (WebLLM) runs on-device in the browser via WebGPU and cannot be dispatched to the server-side /api/chat endpoint.',
        code: 400,
        status: 'LOCAL_PROVIDER_ONLY',
        errorCode: 'LOCAL_PROVIDER_ONLY',
        provider: 'webllm',
        retryable: false,
        canFallback: false
      });
    }

    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  } catch (error: any) {
    if (error?.isClientDisconnected || error?.code === 'CLIENT_DISCONNECTED') {
      return;
    }
    console.error('API Error in /api/chat:', sanitizeErrorLog(error?.message || String(error)));
    const providerName = String(req.body?.provider || 'unknown');
    const parsed = parseGeminiError(error, providerName);
    logAIDiagnostic({
      category: parsed.category || 'internal server error',
      provider: providerName,
      model: String(req.body?.model || 'unknown'),
      phase: 'dispatch',
      upstreamStatus: parsed.statusCode,
      upstreamErrorCode: parsed.status,
      sanitizedMessage: parsed.message
    });
    if (res.headersSent) {
      if (!res.writableEnded) {
        sendSSE(res, {
          type: 'error',
          error: parsed.message,
          code: parsed.statusCode,
          status: parsed.status,
          provider: providerName,
          retryable: parsed.isRetryable,
          canFallback: parsed.isUnavailable ? true : false,
          suggestedProviders: getConfiguredFallbackProviders(providerName, isServerless)
        });
        res.end();
      }
    } else {
      res.status(parsed.statusCode).json({
        error: parsed.message,
        code: parsed.statusCode,
        status: parsed.status,
        provider: providerName,
        retryable: parsed.isRetryable,
        canFallback: parsed.isUnavailable ? true : false,
        suggestedProviders: getConfiguredFallbackProviders(providerName, isServerless)
      });
    }
  }
  });
}
