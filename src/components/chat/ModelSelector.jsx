import React from 'react';
import { Cpu, ChevronDown } from 'lucide-react';
import { PROVIDER_OPTIONS, DEFAULT_PROVIDER } from '../../services/aiRouter.js';
import { getProviderConfigAvailability } from '../../services/providerModelSanitizer.js';

/**
 * ModelSelector Component
 * Allows user to select/change the active AI model / provider while surfacing
 * accurate server configuration availability without disabling selection.
 *
 * @param {Object} props
 * @param {string} [props.selectedProvider='gemini'] - Currently selected provider ID
 * @param {(providerId: string) => void} props.onSelectProvider - Callback when provider changes
 * @param {boolean} [props.compact=false] - Compact mode for mobile header bar
 * @param {string} [props.className=''] - Additional CSS classes
 * @param {string} [props.id='ai-model-select'] - Input ID for label association
 * @param {boolean} [props.disabled=false] - Whether selection is disabled (e.g. during streaming)
 * @param {Object|null} [props.providerConfig=null] - Normalized /api/config status snapshot
 */
export default function ModelSelector({
  selectedProvider = DEFAULT_PROVIDER,
  onSelectProvider,
  compact = false,
  className = '',
  id = 'ai-model-select',
  disabled = false,
  providerConfig = null
}) {
  const currentProvider =
    PROVIDER_OPTIONS.find((p) => p.id === selectedProvider) || PROVIDER_OPTIONS[0];

  const currentAvailability = getProviderConfigAvailability(currentProvider.id, providerConfig);
  const currentBaseLabel =
    currentProvider.id === 'webllm'
      ? 'Browser AI WebLLM'
      : (currentProvider.label || `${currentProvider.name} (${currentProvider.modelTag})`);
  const selectorTitle =
    currentAvailability.state === 'unconfigured'
      ? `AI Model: ${currentBaseLabel} — Server API key not configured`
      : `AI Model: ${currentBaseLabel}`;

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
      title={selectorTitle}
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
          {PROVIDER_OPTIONS.map((provider) => {
            const availability = getProviderConfigAvailability(provider.id, providerConfig);
            const isConfirmedUnconfigured = availability.state === 'unconfigured';
            const baseText =
              provider.id === 'webllm'
                ? 'Browser AI WebLLM'
                : compact
                ? (provider.shortName || provider.name)
                : (provider.label || `${provider.name} (${provider.modelTag})`);
            const suffix = isConfirmedUnconfigured
              ? (compact ? ' (Setup)' : ' — Setup required')
              : '';
            return (
              <option key={provider.id} value={provider.id}>
                {`${baseText}${suffix}`}
              </option>
            );
          })}
        </select>
        <ChevronDown size={12} className="model-selector-chevron" aria-hidden="true" />
      </div>
    </div>
  );
}
