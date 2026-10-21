import React from 'react';
import { Cpu, ChevronDown } from 'lucide-react';
import { PROVIDER_OPTIONS, DEFAULT_PROVIDER } from '../../services/aiRouter.js';

/**
 * ModelSelector Component
 * Allows user to select/change the active AI model / provider (Gemini, Groq, OpenRouter).
 * Restored to its original intended behavior and location in the top navigation bar.
 *
 * @param {Object} props
 * @param {string} [props.selectedProvider='gemini'] - Currently selected provider ID ('gemini' | 'groq' | 'openrouter')
 * @param {(providerId: string) => void} props.onSelectProvider - Callback when provider changes
 * @param {boolean} [props.compact=false] - Compact mode for mobile header bar
 * @param {string} [props.className=''] - Additional CSS classes
 * @param {string} [props.id='ai-model-select'] - Input ID for label association
 * @param {boolean} [props.disabled=false] - Whether selection is disabled (e.g. during streaming)
 */
export default function ModelSelector({
  selectedProvider = DEFAULT_PROVIDER,
  onSelectProvider,
  compact = false,
  className = '',
  id = 'ai-model-select',
  disabled = false
}) {
  const currentProvider =
    PROVIDER_OPTIONS.find((p) => p.id === selectedProvider) || PROVIDER_OPTIONS[0];

  const handleChange = (e) => {
    if (disabled) return;
    const newProvider = e.target.value;
    if (onSelectProvider) {
      onSelectProvider(newProvider);
    }
  };

  return (
    <div
      className={`model-selector-container ${compact ? 'model-selector-compact' : ''} ${className}`}
      title={`AI Model: ${currentProvider.label || `${currentProvider.name} (${currentProvider.modelTag})`}`}
    >
      <label htmlFor={id} className="model-selector-label" title="Active AI Model">
        <Cpu size={14} className="model-selector-icon" aria-hidden="true" />
        {!compact && <span className="model-selector-title">Model:</span>}
      </label>

      <div className="model-selector-dropdown-wrapper">
        <select
          id={id}
          className="model-selector-select"
          value={selectedProvider}
          onChange={handleChange}
          disabled={disabled}
          aria-label="Select AI Model"
        >
          {PROVIDER_OPTIONS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label || (compact ? provider.name : `${provider.name} (${provider.modelTag})`)}
            </option>
          ))}
        </select>
        <ChevronDown size={12} className="model-selector-chevron" aria-hidden="true" />
      </div>
    </div>
  );
}
