import React from 'react';
import {
  Sparkles,
  Code,
  PenTool,
  Compass,
  FileText,
  Lightbulb,
  ArrowUpRight
} from 'lucide-react';
import { APP_CONFIG } from '../../config/appConfig.js';

// Map icon string names to Lucide icons
const ICON_MAP = {
  Sparkles,
  Code,
  PenTool,
  Compass,
  FileText,
  Lightbulb
};

/**
 * PromptSuggestions Component
 * Renders polished smart starter prompt cards on the empty New Chat screen.
 * Clicking any suggestion populates the prompt into the active chat composer.
 *
 * @param {Object} props
 * @param {(promptText: string) => void} props.onSelectPrompt
 */
export default function PromptSuggestions({ onSelectPrompt }) {
  const prompts = APP_CONFIG.starterPrompts || [];

  return (
    <div className="starter-prompts-container" aria-label="Smart prompt suggestions">
      <div className="starter-prompts-header">
        <span className="starter-prompts-caption">Smart Suggestions</span>
      </div>

      <div className="starter-prompts-grid" role="list" aria-label="Suggested starter prompts">
        {prompts.map((item) => {
          const IconComponent = ICON_MAP[item.iconName] || Sparkles;

          return (
            <button
              key={item.id}
              className="prompt-card"
              onClick={() => onSelectPrompt && onSelectPrompt(item.prompt)}
              type="button"
              role="listitem"
              aria-label={`Use suggestion: ${item.title}`}
              title={item.prompt}
            >
              <div className="prompt-card-top">
                <div className="prompt-card-header">
                  <span className="prompt-card-icon" aria-hidden="true">
                    <IconComponent size={15} />
                  </span>
                  <span className="prompt-card-title">{item.title}</span>
                </div>
                <span className="prompt-card-arrow" aria-hidden="true">
                  <ArrowUpRight size={14} />
                </span>
              </div>

              <p className="prompt-card-desc">{item.description}</p>

              {item.category && (
                <div className="prompt-card-footer">
                  <span className="prompt-card-badge">{item.category}</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
