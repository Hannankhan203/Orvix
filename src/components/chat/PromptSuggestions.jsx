import React from 'react';
import { Lightbulb, PenTool, Code, Compass } from 'lucide-react';
import { APP_CONFIG } from '../../config/appConfig.js';

// Map icon strings to Lucide components
const ICON_MAP = {
  Lightbulb,
  PenTool,
  Code,
  Compass
};

/**
 * PromptSuggestions Component
 * Renders suggested starter questions on the welcome screen
 * @param {Object} props
 * @param {(promptText: string) => void} props.onSelectPrompt
 */
export default function PromptSuggestions({ onSelectPrompt }) {
  const prompts = APP_CONFIG.starterPrompts;

  return (
    <div className="starter-prompts-container">
      <div className="starter-prompts-grid" role="list" aria-label="Suggested prompts">
        {prompts.map((item) => {
          const IconComponent = ICON_MAP[item.iconName] || Lightbulb;
          return (
            <button
              key={item.id}
              className="prompt-card"
              onClick={() => onSelectPrompt && onSelectPrompt(item.prompt)}
              type="button"
              role="listitem"
            >
              <div className="prompt-card-header">
                <span className="prompt-card-icon">
                  <IconComponent size={16} />
                </span>
                <span>{item.title}</span>
              </div>
              <p className="prompt-card-desc">{item.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
