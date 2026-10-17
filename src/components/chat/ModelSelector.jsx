import React from 'react';
import { Cpu, ChevronDown } from 'lucide-react';
import { PROVIDER_OPTIONS, DEFAULT_PROVIDER } from '../../services/aiRouter.js';

/**
 * ModelSelector Component
 * Dropdown selector allowing users to switch between Gemini, Groq, and OpenRouter.
 * Supports standard desktop display and compact touch-friendly mobile display.
 *
 * @param {Object} props
 * @param {string} props.selectedProvider
 * @param {(provider: string) => void} props.onSelectProvider
 * @param {boolean} [props.disabled=false]
 * @param {string} [props.className='']
 * @param {boolean} [props.compact=false]
 * @param {string} [props.id]
 */
export default function ModelSelector({
  selectedProvider = DEFAULT_PROVIDER,
  onSelectProvider,
  disabled = false,
  className = '',
  compact = false,
  id
}) {
  const selectId = id || (compact ? 'ai-model-select-compact' : 'ai-model-select');
  const currentProvider = PROVIDER_OPTIONS.find((p) => p.id === selectedProvider) || PROVIDER_OPTIONS[0];

  return (
    <div className={`model-selector-container ${compact ? 'model-selector-compact' : ''} ${className}`}>
      <label htmlFor={selectId} className="model-selector-label" title="Select active AI provider and model">
        <Cpu size={compact ? 13 : 14} className="model-selector-icon" aria-hidden="true" />
        <span className={`model-selector-title ${compact ? 'compact-title' : ''}`}>
          {compact ? 'Model' : 'AI Model'}
        </span>
      </label>

      <div className="model-selector-dropdown-wrapper">
        <select
          id={selectId}
          value={selectedProvider}
          onChange={(e) => onSelectProvider && onSelectProvider(e.target.value)}
          disabled={disabled}
          className={`model-selector-select ${compact ? 'select-compact' : ''}`}
          aria-label="Select AI Model"
          title={`Active Model: ${currentProvider.name} (${currentProvider.modelTag})`}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {compact ? `${opt.name} (${opt.modelTag.split(' ')[0]})` : `${opt.name} (${opt.modelTag})`}
            </option>
          ))}
        </select>
        <ChevronDown size={12} className="model-selector-chevron" aria-hidden="true" />
      </div>
    </div>
  );
}
