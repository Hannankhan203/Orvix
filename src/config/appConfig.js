/**
 * Orvix Application Configuration
 * Core constants, application metadata, and welcome screen starter prompts.
 */

export const APP_CONFIG = {
  name: 'Orvix',
  tagline: 'Your Intelligent AI Conversation Companion',
  description: 'A clean, modern, and responsive AI chatbot for brainstorming, coding, writing, and problem-solving.',
  version: '1.0.0',
  defaultGreeting: 'How can I assist you today?',
  starterPrompts: [
    {
      id: 'brainstorm',
      title: 'Brainstorm ideas',
      description: 'Explore creative concepts for a new product, name, or project pitch',
      prompt: 'Can you help me brainstorm 5 unique concepts for a modern tech startup?',
      iconName: 'Lightbulb'
    },
    {
      id: 'writing',
      title: 'Draft & refine writing',
      description: 'Compose emails, articles, summaries, or edit existing copy',
      prompt: 'Draft a friendly and professional follow-up email after a great client meeting.',
      iconName: 'PenTool'
    },
    {
      id: 'coding',
      title: 'Explain or debug code',
      description: 'Analyze algorithms, syntax, architecture, or tricky bug reports',
      prompt: 'Explain how React useEffect works under the hood with practical code examples.',
      iconName: 'Code'
    },
    {
      id: 'learning',
      title: 'Explore complex topics',
      description: 'Break down science, philosophy, history, or technical principles',
      prompt: 'Explain how neural networks learn like I am a 12-year-old student.',
      iconName: 'Compass'
    }
  ]
};
