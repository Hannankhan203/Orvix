/**
 * Orvix Application Configuration
 * Core constants, application metadata, and welcome screen starter prompts.
 */

/**
 * Centralized Gemini Model Configuration
 * Primary production model and secondary fallback candidate for rate-limit / availability failover.
 */
export const GEMINI_PRIMARY_MODEL = 'gemini-3.8-flash';
export const GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';

export const GEMINI_FALLBACK_CANDIDATES = Object.freeze([
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL
]);

export const GEMINI_MODELS_CONFIG = Object.freeze({
  primary: GEMINI_PRIMARY_MODEL,
  secondary: GEMINI_FALLBACK_MODEL,
  fallbackCandidates: GEMINI_FALLBACK_CANDIDATES
});

export const APP_CONFIG = {
  name: 'Orvix',
  tagline: 'Your Intelligent AI Conversation Companion',
  description: 'A clean, modern, and responsive AI chatbot for brainstorming, coding, writing, and problem-solving.',
  version: '0.3.2',
  defaultGreeting: 'How can I assist you today?',
  gemini: GEMINI_MODELS_CONFIG
};


