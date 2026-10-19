import React from 'react';
import {
  Sparkles,
  Code,
  PenTool,
  Compass,
  FileText,
  Lightbulb,
  BookOpen,
  ArrowUpRight
} from 'lucide-react';
import { APP_CONFIG } from '../../config/appConfig.js';
import { MODE_STARTER_PROMPTS, getChatMode } from '../../config/chatModes.js';

// Map icon string names to Lucide icons
const ICON_MAP = {
  Sparkles,
  Code,
  PenTool,
  Compass,
  FileText,
  Lightbulb,
  BookOpen
};

/**
 * PromptSuggestions Component
 * Renders polished smart starter prompt cards on the empty New Chat screen,
 * dynamically reflecting the active Chat Mode.
 *
 * @param {Object} props
 * @param {(promptText: string) => void} props.onSelectPrompt
 * @param {string} [props.activeMode='general']
 */
export default function PromptSuggestions({ onSelectPrompt, activeMode = 'general' }) {
  const modeObj = getChatMode(activeMode);
  const tailoredPrompts = MODE_STARTER_PROMPTS[activeMode];
  const prompts = tailoredPrompts && tailoredPrompts.length > 0 ? tailoredPrompts : (APP_CONFIG.starterPrompts || []);

  return (
    <div className="starter-prompts-container" aria-label="Smart prompt suggestions">
      <div className="starter-prompts-header">
        <span className="starter-prompts-caption">
          {modeObj.name} Suggestions
        </span>
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
