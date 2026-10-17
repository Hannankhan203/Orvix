import React from 'react';
import { Bot, Sparkles } from 'lucide-react';
import { APP_CONFIG } from '../../config/appConfig.js';
import PromptSuggestions from './PromptSuggestions.jsx';

/**
 * WelcomeScreen Component
 * Displays the welcoming empty state with "What can I help you with?" heading
 * and starter conversation suggestions.
 * @param {Object} props
 * @param {(promptText: string) => void} props.onSelectPrompt
 */
export default function WelcomeScreen({ onSelectPrompt }) {
  return (
    <div className="welcome-screen">
      <div className="welcome-hero">
        <div className="welcome-badge">
          <Sparkles size={13} className="welcome-badge-icon" />
          <span>{APP_CONFIG.name}</span>
        </div>

        <h1 className="welcome-heading">What can I help you with?</h1>
        <p className="welcome-subheading">
          Ask a question, brainstorm new concepts, or draft content. Choose a suggestion below or type your prompt to get started.
        </p>
      </div>

      <PromptSuggestions onSelectPrompt={onSelectPrompt} />
    </div>
  );
}
