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

/**
 * Mode-tailored starter prompt suggestions for the WelcomeScreen.
 */
export const MODE_STARTER_PROMPTS = {
  general: [
    {
      id: 'general-brainstorm',
      category: 'Brainstorm',
      title: 'Brainstorm creative concepts',
      description: 'Explore innovative ideas for projects, features, and workflows',
      prompt: 'Help me brainstorm 5 unique and practical product ideas combining AI assistance with everyday productivity tools.',
      iconName: 'Sparkles'
    },
    {
      id: 'general-plan',
      category: 'Planning',
      title: 'Plan a project step by step',
      description: 'Organize milestones, deliverables, phases, and timeline risks',
      prompt: 'Help me plan a full-stack web application launch step by step from MVP to deployment, including key milestones and risks.',
      iconName: 'Compass'
    },
    {
      id: 'general-compare',
      category: 'Compare',
      title: 'Compare options objectively',
      description: 'Weigh trade-offs, pros, and cons to make an informed decision',
      prompt: 'Compare working as a software engineer at a seed-stage startup versus an established tech company. Outline pros, cons, and career growth trade-offs.',
      iconName: 'Lightbulb'
    },
    {
      id: 'general-email',
      category: 'Productivity',
      title: 'Draft a diplomatic follow-up',
      description: 'Write a polite, structured email to keep momentum on a project',
      prompt: 'Draft a polite and professional follow-up email to a collaborator regarding milestone deliverables and next week\'s sync.',
      iconName: 'PenTool'
    }
  ],
  coding: [
    {
      id: 'code-debug',
      category: 'Debugging',
      title: 'Help me debug code',
      description: 'Find logical bugs, memory leaks, or race conditions in code',
      prompt: 'Help me review and debug this code, explain why it might fail, and show a robust fix:\n\n```javascript\nasync function fetchUserData(userIds) {\n  return userIds.map(async (id) => {\n    const res = await fetch(`/api/user/${id}`);\n    return res.json();\n  });\n}\n```',
      iconName: 'Code'
    },
    {
      id: 'code-arch',
      category: 'Architecture',
      title: 'Architect a clean backend service',
      description: 'Design modular layers, error handling, and data models',
      prompt: 'Design a clean, production-ready Express + TypeScript service architecture for managing real-time chat rooms with WebSockets and in-memory caching.',
      iconName: 'Code'
    },
    {
      id: 'code-refactor',
      category: 'Refactoring',
      title: 'Refactor for performance',
      description: 'Optimize rendering cycles, state updates, and algorithmic complexity',
      prompt: 'How can I optimize this React component to prevent unnecessary re-renders when parent state updates frequently?',
      iconName: 'Code'
    },
    {
      id: 'code-test',
      category: 'Testing',
      title: 'Write automated unit tests',
      description: 'Generate unit and edge-case test suites using Vitest or Jest',
      prompt: 'Write comprehensive unit tests with edge cases for an authentication token validation function using Vitest.',
      iconName: 'Code'
    }
  ],
  writing: [
    {
      id: 'write-email',
      category: 'Email',
      title: 'Draft a professional announcement',
      description: 'Write a persuasive, polished update to team stakeholders',
      prompt: 'Draft an executive-ready project status update informing leadership that our MVP was delivered ahead of schedule and with zero critical bugs.',
      iconName: 'PenTool'
    },
    {
      id: 'write-rewrite',
      category: 'Polishing',
      title: 'Improve clarity and conciseness',
      description: 'Refactor wordy text into crisp, high-impact prose',
      prompt: 'Please rewrite this text to make it more punchy, professional, and engaging while keeping the key facts:\n\n"We are writing this message because we wanted to let everyone know that there will be some changes happening soon regarding the tools we use on our team."',
      iconName: 'PenTool'
    },
    {
      id: 'write-blog',
      category: 'Drafting',
      title: 'Outline a technical blog post',
      description: 'Structure a compelling narrative with hooks, sections, and takeaways',
      prompt: 'Create a compelling outline for a technical blog post titled "Why Simplicity Wins: Building High-Performance Web Apps in 2026".',
      iconName: 'PenTool'
    },
    {
      id: 'write-tone',
      category: 'Tone Shift',
      title: 'Adjust tone for client presentation',
      description: 'Transform informal notes into a refined client proposal',
      prompt: 'Help me turn these informal project bullet points into an elegant client proposal section highlighting value and reliability.',
      iconName: 'PenTool'
    }
  ],
  learning: [
    {
      id: 'learn-concept',
      category: 'Foundations',
      title: 'Explain a difficult concept simply',
      description: 'Break down complex ideas with intuitive everyday analogies',
      prompt: 'Explain quantum computing and how quantum bits (qubits) differ from classical bits in simple terms with an everyday analogy.',
      iconName: 'BookOpen'
    },
    {
      id: 'learn-breakdown',
      category: 'Step-by-Step',
      title: 'Break down a complex process',
      description: 'Demystify how a mechanism works under the hood',
      prompt: 'Explain step-by-step what happens under the hood when a user types a URL into a web browser and hits Enter until the page is rendered.',
      iconName: 'BookOpen'
    },
    {
      id: 'learn-compare',
      category: 'Mental Models',
      title: 'Compare two paradigms',
      description: 'Build intuition around trade-offs and when to use each approach',
      prompt: 'Explain the core conceptual differences between SQL and NoSQL databases, using a physical library and filing cabinet analogy.',
      iconName: 'BookOpen'
    },
    {
      id: 'learn-quiz',
      category: 'Active Recall',
      title: 'Check my understanding',
      description: 'Interactive question and explanation walkthrough',
      prompt: 'Teach me the basics of public-key cryptography, give a clear analogy for how encryption keys work, and ask me 2 simple questions to test my understanding.',
      iconName: 'BookOpen'
    }
  ]
};
