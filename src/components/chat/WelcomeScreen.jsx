import React from 'react';
import { APP_CONFIG } from '../../config/appConfig.js';
import PromptSuggestions from './PromptSuggestions.jsx';
import ModeSelector from './ModeSelector.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';

/**
 * WelcomeScreen Component
 * Displays the welcoming empty state with "What can I help you with?" heading,
 * interactive Chat Mode selector, and smart conversation starter suggestions.
 *
 * @param {Object} props
 * @param {(promptText: string) => void} props.onSelectPrompt
 * @param {string|null} [props.username=null]
 * @param {string} [props.activeMode='general']
 * @param {(modeId: string) => void} [props.onSelectMode]
 */
export default function WelcomeScreen({
  onSelectPrompt,
  username = null,
  activeMode = 'general',
  onSelectMode
}) {
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
          Select a chat mode below or choose a starter prompt to tailor how Orvix assists you.
        </p>

        {/* Prominent Chat Mode Selector Pills */}
        <ModeSelector
          activeMode={activeMode}
          onSelectMode={onSelectMode}
          variant="pills"
          className="welcome-mode-selector"
        />
      </div>

      <PromptSuggestions
        onSelectPrompt={onSelectPrompt}
        activeMode={activeMode}
      />
    </div>
  );
}
