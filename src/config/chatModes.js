/**
 * Orvix Chat Modes Configuration
 * Defines supported conversational modes, metadata, icons, and system instruction extensions.
 */

import { Sparkles, Code, PenTool, BookOpen } from 'lucide-react';

export const CHAT_MODES = {
  general: {
    id: 'general',
    name: 'General Assistant',
    shortName: 'General',
    tagline: 'Versatile companion for general questions, brainstorming, and everyday tasks',
    description: 'Helpful, versatile general assistant behavior for everyday queries and problem solving.',
    icon: Sparkles,
    iconName: 'Sparkles',
    instruction: '' // Base Orvix companion instruction handles general mode
  },
  coding: {
    id: 'coding',
    name: 'Coding',
    shortName: 'Coding',
    tagline: 'Code generation, debugging, software architecture, and step-by-step technical guidance',
    description: 'Help with programming, debugging, code explanations, and step-by-step technical guidance.',
    icon: Code,
    iconName: 'Code',
    instruction:
      'Active Mode: Coding. Prioritize high-quality programming guidance, software architecture, syntax review, and debugging. Provide clean, correct, and well-structured code blocks with accurate language identifiers. Explain how the code operates, highlight edge cases or potential pitfalls, and guide the user through step-by-step technical problem solving without making ungrounded assumptions.'
  },
  writing: {
    id: 'writing',
    name: 'Writing',
    shortName: 'Writing',
    tagline: 'Drafting, editing, tone adjustment, and polishing written prose',
    description: 'Help with drafting, editing, rewriting, tone polishing, and improving written content.',
    icon: PenTool,
    iconName: 'PenTool',
    instruction:
      'Active Mode: Writing. Prioritize drafting, editing, rewriting, tone adjustment, and prose enhancement. Focus on clarity, flow, rhythm, grammatical precision, and compelling structure. Offer constructive suggestions, varied phrasing alternatives, and polished text tailored to the user\'s intended audience and purpose.'
  },
  learning: {
    id: 'learning',
    name: 'Learning',
    shortName: 'Learning',
    tagline: 'Conceptual breakdowns, intuitive analogies, and step-by-step educational explanations',
    description: 'Explain concepts clearly, break difficult topics into manageable steps, and use examples where useful.',
    icon: BookOpen,
    iconName: 'BookOpen',
    instruction:
      'Active Mode: Learning. Prioritize clear educational explanations and concept mastery. Break complex topics down into logical, easily digestible steps. Use relatable real-world analogies, illustrative examples, and intuitive comparisons. Encourage deep understanding by highlighting key takeaways and offering helpful conceptual summaries.'
  }
};

export const DEFAULT_CHAT_MODE = 'general';

export const CHAT_MODE_LIST = [
  CHAT_MODES.general,
  CHAT_MODES.coding,
  CHAT_MODES.writing,
  CHAT_MODES.learning
];

/**
 * Safely resolves a mode object by ID with fallback to General Assistant.
 * @param {string|null|undefined} modeId
 * @returns {typeof CHAT_MODES.general}
 */
export function getChatMode(modeId) {
  if (modeId && typeof modeId === 'string') {
    const normalized = modeId.toLowerCase().trim();
    if (CHAT_MODES[normalized]) {
      return CHAT_MODES[normalized];
    }
  }
  return CHAT_MODES.general;
}

