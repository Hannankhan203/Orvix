/**
 * Orvix Mock Chat Service (Temporary Demonstration Only)
 *
 * NOTE: This module provides temporary simulated responses exclusively for testing
 * local UI state and user interactions before external AI (Gemini) is integrated.
 * No external network requests or persistence are used.
 */

export function generateSimulatedResponse(userPrompt) {
  const promptLower = userPrompt.toLowerCase();

  let body = '';

  if (promptLower.includes('code') || promptLower.includes('react') || promptLower.includes('javascript') || promptLower.includes('bug')) {
    body = `Here is a simulated technical answer for your query:

\`\`\`javascript
// Simulated code example
function handleChatInteraction(message) {
  const sanitized = message.trim();
  if (!sanitized) return null;
  
  return {
    id: 'msg-' + Date.now(),
    text: sanitized,
    status: 'delivered'
  };
}
\`\`\`

• **State updates:** Messages are appended immutably to local component state.
• **Auto-scroll:** The message stream pins to the latest message smoothly.
• **Input reset:** The composer automatically clears and resets its height.`;
  } else if (promptLower.includes('brainstorm') || promptLower.includes('idea') || promptLower.includes('startup') || promptLower.includes('name')) {
    body = `Here are 3 simulated brainstormed concepts:

1. **NexusFlow** — Streamlined project orchestration with conversational workflows.
2. **PulseDraft** — Minimalist ambient drafting tool for authors and researchers.
3. **OmniCanvas** — Spatial thinking board connecting notes and conversation threads.

*Tip: You can start another query or click "+ New Chat" to test resetting the conversation.*`;
  } else if (promptLower.startsWith('hi') || promptLower.startsWith('hello') || promptLower.startsWith('hey')) {
    body = `Hello! I am **Orvix** in local interaction testing mode.

You can test:
• **Multiline input:** Press **Shift + Enter** to create new lines.
• **Quick submission:** Press **Enter** to submit instantly.
• **Empty validation:** Notice the Send button disables when empty.
• **Loading indicator:** Notice the subtle thinking state while responses generate.`;
  } else {
    body = `Thank you for your prompt:
> "${userPrompt}"

**Interaction Checklist Verified:**
• Message submitted successfully to local memory state.
• Composer input cleared and restored to default height.
• Loading indicator displayed during simulated generation.
• Duplicate submission prevention remained active during generation.`;
  }

  return `**[Simulated Response — UI Testing Mode]**

${body}

---
*Notice: This is a temporary in-memory simulated response for Phase 3 evaluation. External AI services (Gemini) are not connected yet.*`;
}
