/**
 * Orvix Multi-Part Response & Large Output Handling Service
 * Detects requests likely to exceed safe response token/character budgets,
 * coordinates controlled multi-part generation, manages continuation detection,
 * and preserves context (original prompt, attachments, covered sections) across parts.
 */

export const CONTINUATION_NOTICES = {
  PART_1: '\n\n---\n**This is a large response, so I’ve provided the first part. Reply "Continue" and I’ll send the rest.**',
  PART_N: '\n\n---\n**There is still more to cover. Reply "Continue" for the next part.**'
};

// Patterns matching user requests to continue an incomplete or partitioned response
const CONTINUATION_PHRASES = [
  'continue',
  'cont',
  'go on',
  'carry on',
  'keep going',
  'send the rest',
  'send rest',
  'give me the rest',
  'give me the remaining part',
  'show the rest',
  'tell me the rest',
  'what is the rest',
  'whats the rest',
  'remaining part',
  'remaining parts',
  'next',
  'next part',
  'next section',
  'part 2',
  'part 3',
  'part 4',
  'part 5',
  'more',
  'more please',
  'continue response',
  'continue please',
  'please continue',
  'proceed',
  'finish the answer',
  'complete the answer',
  'finish the response'
];

/**
 * Checks whether a user message text represents an explicit request to continue
 * a previous partitioned or multi-part AI answer.
 * @param {string} text
 * @returns {boolean}
 */
export function isContinuationRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase().replace(/[.!?,:;]/g, '');

  if (CONTINUATION_PHRASES.includes(clean)) return true;

  // Flexible regular expressions matching variations like "please continue", "continue with the rest", "send part 2"
  if (/^(?:please\s+)?continue(?:\s+(?:with\s+)?(?:the\s+)?(?:rest|next|response|answer|part\s*\d*|section\s*\d*))?$/i.test(clean)) {
    return true;
  }
  if (/^(?:send|give\s+me|show)\s+(?:the\s+)?(?:rest|remaining(?:\s+part)?)$/i.test(clean)) {
    return true;
  }
  if (/^part\s*\d+$/i.test(clean)) {
    return true;
  }
  if (/^(?:can\s+you\s+)?(?:continue|finish|complete)(?:\s+this)?$/i.test(clean)) {
    return true;
  }

  return false;
}

/**
 * Checks whether an assistant response content ended with a continuation invitation.
 * @param {string} content
 * @returns {boolean}
 */
export function responseHasContinuationNotice(content) {
  if (!content || typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('reply "continue"') ||
    lower.includes('reply continue') ||
    lower.includes('reply "continue" and i’ll send the rest') ||
    lower.includes('reply "continue" for the next part') ||
    lower.includes('i’ve provided the first part') ||
    lower.includes('there is still more to cover')
  );
}

/**
 * Analyzes user request complexity, attachment context size, response style,
 * and level of detail to determine if an answer is likely too large for a safe single response.
 *
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Array<Object>} [params.docs=[]]
 * @param {Object|null} [params.preferences=null]
 * @param {string} [params.mode='general']
 * @param {Array<Object>} [params.history=[]]
 * @returns {{ isLikelyLarge: boolean, reason?: string }}
 */
export function detectLargeResponseIntent({
  prompt = '',
  docs = [],
  preferences = null,
  mode = 'general',
  history = []
}) {
  if (!prompt || typeof prompt !== 'string') {
    return { isLikelyLarge: false };
  }

  const lowerPrompt = prompt.toLowerCase().trim();

  // If this is a continuation request, it's already part of a multi-part sequence
  if (isContinuationRequest(prompt)) {
    return { isLikelyLarge: true, reason: 'continuation' };
  }

  // 1. Explicit comprehensive / exhaustive request patterns
  const exhaustivePatterns = [
    /\b(?:explain|cover|break down|analyze|detail)\s+(?:every|each|all)\s+(?:section|part|chapter|page|slide|topic|step|component)/i,
    /\b(?:in\s+(?:complete|full|exhaustive|great|deep)\s+detail)\b/i,
    /\b(?:comprehensive|exhaustive|complete|step-by-step)\s+(?:guide|breakdown|analysis|overview|walkthrough|explanation)\b/i,
    /\b(?:line\s+by\s+line|section\s+by\s+section|page\s+by\s+page)\b/i,
    /\b(?:entire|whole)\s+(?:document|pdf|file|presentation|codebase)\s+in\s+detail\b/i,
    /\b(?:write\s+a\s+(?:complete|full|lengthy|detailed|in-depth)\s+(?:essay|report|guide|documentation|tutorial|analysis))\b/i
  ];

  for (const pattern of exhaustivePatterns) {
    if (pattern.test(lowerPrompt)) {
      return {
        isLikelyLarge: true,
        reason: 'User explicitly requested an exhaustive, multi-section detailed breakdown.'
      };
    }
  }

  // 2. Large document attachment with a whole-document question
  // Differentiates large context from large response:
  // - "What is the title?" on a 50-page PDF -> isLikelyLarge = FALSE (short answer)
  // - "Explain this whole document in detail" on a 50-page PDF -> isLikelyLarge = TRUE
  if (Array.isArray(docs) && docs.length > 0) {
    const primaryDoc = docs[0];
    const totalChars = primaryDoc?.totalCharacters || (primaryDoc?.text ? primaryDoc.text.length : 0);
    const pageCount = primaryDoc?.pageCount || 0;
    const slideCount = primaryDoc?.slideCount || 0;
    const isSubstantialDoc = totalChars > 12000 || pageCount >= 4 || slideCount >= 4;

    const broadDocumentQuery =
      /\b(?:explain|summarize|breakdown|break down|analyze|review|walkthrough|tell me about)\s+(?:this|the|all of)\s*(?:whole|entire|full)?\s*(?:document|pdf|file|deck|presentation|paper|report)/i.test(lowerPrompt) ||
      /\bwhat\s+(?:is\s+in|does\s+(?:this|the)\s+document\s+(?:say|cover))\b/i.test(lowerPrompt);

    const specificSmallQuery =
      /\b(?:title|author|date|heading|name|who wrote|when was|what is the name|one sentence|single line|briefly|in short|quick answer)\b/i.test(lowerPrompt);

    if (isSubstantialDoc && broadDocumentQuery && !specificSmallQuery) {
      if (preferences?.responseLength === 'detailed' || preferences?.responseLength === 'balanced') {
        return {
          isLikelyLarge: true,
          reason: 'Substantial document attached with a broad, in-depth explanation requested.'
        };
      }
    }
  }

  // 3. User requested 'detailed' response length combined with multi-part question
  if (preferences?.responseLength === 'detailed') {
    const multiQuestionOrSteps =
      /\b(?:1\..*2\.|first.*second.*third|step\s+by\s+step|pros\s+and\s+cons|advantages\s+and\s+disadvantages|full\s+code\s+implementation)\b/i.test(lowerPrompt);
    if (multiQuestionOrSteps && lowerPrompt.length > 80) {
      return {
        isLikelyLarge: true,
        reason: 'Detailed preference with multi-step or multi-part complex inquiry.'
      };
    }
  }

  return { isLikelyLarge: false };
}

/**
 * Searches backwards through the message history to reconstruct the multi-part context:
 * - The original user prompt that triggered the multi-part sequence
 * - The previously delivered assistant parts
 * - The part number we are generating
 * - Any referenced attachment(s)
 *
 * @param {Array<Object>} history
 * @param {string} currentPrompt
 * @returns {Object}
 */
export function resolveMultiPartContext(history = [], currentPrompt = '') {
  const isContinuation = isContinuationRequest(currentPrompt);
  if (!isContinuation || !Array.isArray(history) || history.length === 0) {
    return {
      isContinuation: false,
      partNumber: 1,
      originalPrompt: currentPrompt,
      previousParts: [],
      previousContentSummary: '',
      referencedAttachments: []
    };
  }

  // Scan backwards to find the previous assistant messages that belong to this sequence
  const previousAssistantMessages = [];
  let originalUserMessage = null;
  let referencedAttachments = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg) continue;

    if (msg.sender === 'assistant' && !msg.isError) {
      previousAssistantMessages.unshift(msg);
      if (Array.isArray(msg.referencedAttachments) && msg.referencedAttachments.length > 0 && referencedAttachments.length === 0) {
        referencedAttachments = msg.referencedAttachments;
      }
    } else if (msg.sender === 'user') {
      // Check if this user message was itself a "Continue" request
      if (isContinuationRequest(msg.content)) {
        continue;
      } else {
        // Found the original prompt that began this inquiry
        originalUserMessage = msg;
        if (Array.isArray(msg.attachments) && msg.attachments.length > 0 && referencedAttachments.length === 0) {
          referencedAttachments = msg.attachments;
        }
        break;
      }
    }
  }

  const originalPrompt = originalUserMessage?.content || currentPrompt;
  const partNumber = previousAssistantMessages.length + 1;

  // Extract what has already been explained to prevent repetition
  const previousPartsContent = previousAssistantMessages.map((m) => m.content || '').join('\n\n---\n\n');
  const cleanPreviousContent = previousPartsContent
    .replace(/\n\n---\n\*\*.*?(?:reply|continue).*?\*\*/gi, '')
    .trim();

  return {
    isContinuation: true,
    partNumber,
    originalPrompt,
    previousParts: previousAssistantMessages,
    previousContentSummary: cleanPreviousContent.slice(-2500),
    referencedAttachments
  };
}

/**
 * Builds tailored prompt augmentation for AI models to ensure:
 * - Part 1 covers initial topics deeply and ends with Part 1 continuation notice
 * - Part 2+ continues seamlessly without repeating Part 1 and finishes or continues as needed
 *
 * @param {Object} params
 * @param {boolean} params.isLikelyLarge
 * @param {boolean} params.isContinuation
 * @param {number} params.partNumber
 * @param {string} params.originalPrompt
 * @param {string} params.previousContentSummary
 * @param {string} params.provider
 * @returns {string}
 */
export function buildMultiPartPromptAugmentation({
  isLikelyLarge,
  isContinuation,
  partNumber = 1,
  originalPrompt = '',
  previousContentSummary = '',
  provider = 'gemini'
}) {
  if (!isLikelyLarge && !isContinuation) {
    return '';
  }

  if (isContinuation) {
    return `

[CONTROLLED MULTI-PART CONTINUATION — GENERATING PART ${partNumber}]
The user replied to continue their previous inquiry: "${originalPrompt}".
You must generate the NEXT part (Part ${partNumber}) of the same answer.

CRITICAL CONTINUATION RULES:
1. Continue DIRECTLY from where Part ${partNumber - 1} stopped.
2. DO NOT restart from the beginning.
3. DO NOT repeat the introduction, overview, or sections already explained in previous parts.
4. Begin immediately with the next section, topic, or code component (e.g., "### Part ${partNumber}: Continuing with...").
5. What was already covered in previous parts:
"""
${previousContentSummary || '(Previous sections delivered)'}
"""
6. Completion Check:
   - If this part COMPLETES the entire requested answer, conclude naturally with key takeaways or a summary, and DO NOT ask the user to reply "Continue".
   - If the answer still has extensive remaining material to cover, conclude with this EXACT notice on its own line:
${CONTINUATION_NOTICES.PART_N}`;
  }

  // Part 1 of an anticipated large response
  return `

[CONTROLLED MULTI-PART RESPONSE — GENERATING PART 1]
The user's question or attached document requires a comprehensive, in-depth explanation that is too large to safely fit in a single response without hitting output-token limits.
You must intentionally generate this answer in controlled parts.

CRITICAL RULES FOR PART 1:
1. Provide a detailed, high-quality, thorough explanation for the FIRST PORTION of the request (e.g., Overview and the initial 2-4 key sections or pages).
2. DO NOT rush through or provide a shallow summary of the entire document just to fit it in one message. Cover the initial sections with complete depth and detail.
3. At the very end of your response, on a new line after a horizontal rule, provide this EXACT continuation message:
${CONTINUATION_NOTICES.PART_1}
4. DO NOT say there was an error, crash, or token limit timeout.
5. DO NOT claim the answer is complete when more sections remain.`;
}

/**
 * Builds high-fidelity simulated multi-part responses for demo/offline mode.
 * Generates structured Part 1 and Part 2 responses based on document content and question.
 *
 * @param {Object} params
 * @returns {string}
 */
export function generateSimulatedMultiPartResponse({
  prompt,
  docs = [],
  username = null,
  preferences = null,
  mode = 'general',
  isContinuation = false,
  partNumber = 1,
  originalPrompt = ''
}) {
  const greeting = username ? ` ${username}` : '';
  const effectivePrompt = isContinuation && originalPrompt ? originalPrompt : prompt;
  const primaryDoc = docs && docs.length > 0 ? docs[0] : null;
  const docName = primaryDoc ? (primaryDoc.originalName || primaryDoc.filename || 'Document') : 'Requested Topic';

  if (!isContinuation) {
    // Generate Part 1
    if (primaryDoc) {
      const pageInfo = primaryDoc.pageCount ? ` (${primaryDoc.pageCount} Pages)` : '';
      return `### Comprehensive Breakdown: "${docName}"${pageInfo} — [Part 1 of 2]

Hello${greeting}! Because this document contains substantial material, I’ve organized the analysis into structured parts to ensure every section receives thorough, in-depth coverage.

---

#### Section 1: Executive Overview & Core Objectives
Based on the extracted text from **${docName}**:
• **Primary Subject:** The document outlines key principles, methodologies, and operational guidelines.
• **Core Purpose:** Designed to establish a standard framework for implementing, measuring, and optimizing outcomes.
• **Target Audience:** Technical architects, decision makers, and team contributors.

#### Section 2: Foundational Principles & Structural Framework
1. **System Modularity:** Components are partitioned into independent, decoupled units to ensure reliability and maintainability.
2. **Defensive Validation:** Every input is validated before execution to prevent downstream errors or race conditions.
3. **Data Integrity:** Strict schemas and verification signatures guard against unexpected corruption or misconfiguration.

#### Section 3: Key Processes & Operational Workflow
• **Initiation Phase:** Establishing prerequisites, runtime configurations, and authentication checks.
• **Transformation Phase:** Ingestion, parsing, and context binding with resilient fallback policies.
• **Delivery Phase:** Progressive streaming and state synchronization across sessions.

---
**This is a large response, so I’ve provided the first part. Reply "Continue" and I’ll send the rest.**`;
    }

    // General large question Part 1
    return `### In-Depth Analysis: "${effectivePrompt.slice(0, 45)}" — [Part 1 of 2]

Hello${greeting}! To provide the thorough, comprehensive explanation you requested without compromising on technical detail, I've divided this response into structured parts.

---

#### 1. Core Architectural Concepts
Every robust implementation starts with understanding the foundational requirements:
• **Reliability:** Ensuring systems gracefully degrade and provide clear feedback rather than unhandled errors.
• **Separation of Concerns:** Isolating business logic from delivery layers and state storage.
• **Bounded Resource Usage:** Managing throughput, tokens, and payloads predictably.

#### 2. Technical Breakdown & Step-by-Step Architecture
\`\`\`javascript
/**
 * Phase 1: Core Controller & Safe Processing Pipeline
 */
export async function executePhaseOne(inputPayload) {
  // Validate and sanitize input payload
  const validated = inputPayload && typeof inputPayload === 'object' ? inputPayload : {};
  const items = Array.isArray(validated.items) ? validated.items : [];

  return {
    status: 'phase_1_complete',
    processedCount: items.length,
    timestamp: Date.now()
  };
}
\`\`\`

#### 3. Key Operational Considerations
1. **Input Sanitization:** Guard all ingress boundaries against malformed or out-of-spec inputs.
2. **Predictable State Transitions:** Maintain deterministic ordering across state mutations.

---
**This is a large response, so I’ve provided the first part. Reply "Continue" and I’ll send the rest.**`;
  }

  // Generate Part 2 (Continuation)
  if (primaryDoc) {
    return `### Comprehensive Breakdown: "${docName}" — [Part 2: Final Sections & Conclusion]

Continuing directly from Section 3 where Part 1 concluded:

---

#### Section 4: Advanced Edge Cases & Recovery Protocols
• **Fail-Safe Boundaries:** When upstream services or external dependencies experience high demand, the system activates automated backoff with jitter.
• **State Preservation:** Conversation history and document context are cached in persistent storage, preventing duplicate work.
• **Ephemeral Disk Handling:** In serverless or containerized environments, in-memory buffers ensure zero read-only filesystem faults.

#### Section 5: Comparative Synthesis & Best Practices
1. **Stream Management:** Use Server-Sent Events (SSE) with progressive buffer decoding to minimize Time-to-First-Token (TTFT).
2. **Multi-Part Partitioning:** Divide complex outputs into manageable chunks so users receive actionable information without hitting token exhaustion limits.
3. **Observability:** Maintain sanitized telemetry logging that never leaks API tokens or personal credentials.

#### Section 6: Summary & Practical Takeaways
The analysis of **${docName}** is now complete across Parts 1 and 2. All primary sections, architectures, and implementation recommendations have been covered.

---
💡 **Next Steps:** Would you like to dive deeper into any specific section, or explore how to apply these recommendations to a specific use case?`;
  }

  // General large question Part 2
  return `### In-Depth Analysis: "${effectivePrompt.slice(0, 45)}" — [Part 2: Advanced Implementation & Synthesis]

Continuing directly from where Part 1 concluded:

---

#### 4. Implementation Phase 2 & Advanced Patterns
Building upon the Phase 1 controller, here is the full orchestration logic:

\`\`\`javascript
/**
 * Phase 2: Full Orchestration & Multi-Part Synthesis
 */
export async function executePhaseTwo(sessionContext) {
  const { session, results } = sessionContext;
  
  // Synthesize outcomes from all execution phases
  return {
    completed: true,
    totalPhases: 2,
    sessionSummary: \`Executed successfully for session: \${session?.id || 'default'}\`,
    data: results || []
  };
}
\`\`\`

#### 5. Performance Optimization & Production Safeguards
• **Memory Efficiency:** Avoid unbounded buffering of large data streams by releasing chunk iterators promptly.
• **Concurrency Control:** Queue asynchronous background tasks with bounded limits to prevent thread starvation.
• **Client Experience:** Keep user controls responsive with immediate feedback during heavy computations.

#### 6. Complete Synthesis & Final Checklist
This concludes the full breakdown of your request. You now have both the foundational architecture (Part 1) and the production-ready execution patterns (Part 2). Feel free to ask if you would like to test or extend any specific component!`;
}
