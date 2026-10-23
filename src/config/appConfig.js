/**
 * Orvix Application Configuration
 * Core constants, application metadata, and welcome screen starter prompts.
 */

export const APP_CONFIG = {
  name: 'Orvix',
  tagline: 'Your Intelligent AI Conversation Companion',
  description: 'A clean, modern, and responsive AI chatbot for brainstorming, coding, writing, and problem-solving.',
  version: '0.9.0',
  defaultGreeting: 'How can I assist you today?',
  starterPrompts: [
    {
      id: 'concept',
      category: 'Explain',
      title: 'Explain a difficult concept',
      description: 'Break down complex topics into simple, intuitive terms with analogies',
      prompt: 'Explain quantum computing and how it differs from classical computing in simple terms with everyday analogies.',
      iconName: 'Sparkles'
    },
    {
      id: 'debug',
      category: 'Coding',
      title: 'Help me debug code',
      description: 'Find bugs, analyze errors, and optimize code performance',
      prompt: 'Help me debug this code and explain how to fix any issues or performance bottlenecks:\n\n```javascript\nfunction processItems(items) {\n  return items.map(item => item.value);\n}\n```',
      iconName: 'Code'
    },
    {
      id: 'email',
      category: 'Writing',
      title: 'Write a professional email',
      description: 'Draft or improve emails with clear tone, diplomacy, and structure',
      prompt: 'Draft a polite and professional follow-up email to a client regarding project milestones and scheduling a brief review meeting.',
      iconName: 'PenTool'
    },
    {
      id: 'plan',
      category: 'Planning',
      title: 'Plan a project step by step',
      description: 'Organize milestones, phases, deliverables, and timeline checklists',
      prompt: 'Help me plan a full-stack web application launch step by step from MVP to deployment, including key milestones and risks.',
      iconName: 'Compass'
    },
    {
      id: 'summary',
      category: 'Study',
      title: 'Summarize revision notes',
      description: 'Condense detailed topics into high-yield, structured study notes',
      prompt: 'Summarize the core principles and trade-offs of relational vs NoSQL databases into concise, bulleted revision notes.',
      iconName: 'FileText'
    },
    {
      id: 'brainstorm',
      category: 'Creative',
      title: 'Brainstorm creative ideas',
      description: 'Explore novel concepts, product features, and project pitches',
      prompt: 'Help me brainstorm 5 unique and innovative product concepts combining AI assistance with everyday productivity tools.',
      iconName: 'Lightbulb'
    }
  ]
};
