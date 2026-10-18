import React from 'react';
import { APP_CONFIG } from '../../config/appConfig.js';
import PromptSuggestions from './PromptSuggestions.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';

/**
 * WelcomeScreen Component
 * Displays the welcoming empty state with "What can I help you with?" heading
 * and smart conversation starter suggestions.
 *
 * @param {Object} props
 * @param {(promptText: string) => void} props.onSelectPrompt
 * @param {string|null} [props.username=null]
 */
export default function WelcomeScreen({ onSelectPrompt, username = null }) {
  const cleanName =
    typeof username === 'string' &&
    username.trim() &&
    username !== 'Guest Explorer' &&
    !username.startsWith('guest-')
      ? username.trim()
      : null;

  return (
    <div className="welcome-screen" role="region" aria-label="Welcome screen">
      <div className="welcome-hero">
        <div className="welcome-badge" aria-hidden="true">
          <OrvixLogo size={18} />
          <span>{APP_CONFIG.name}</span>
        </div>

        <h1 className="welcome-heading">
          {cleanName ? `What can I help you with, ${cleanName}?` : 'What can I help you with today?'}
        </h1>
        <p className="welcome-subheading">
          Ask a question, analyze code, or draft content. Choose a smart suggestion below or type your prompt in the composer to get started.
        </p>
      </div>

      <PromptSuggestions onSelectPrompt={onSelectPrompt} />
    </div>
  );
}
