import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  X,
  Layers,
  Wand2,
  Check,
  AlertCircle
} from 'lucide-react';
import Button from '../ui/Button.jsx';

const EXAMPLE_PROMPTS = [
  'A cute Pixar-style tiny origami robot exploring a miniature greenhouse',
  'A cyberpunk neon night market in Tokyo with wet reflective streets',
  'Cinematic oil painting of an astronaut meditating in an alien forest',
  'Isometric 3D render of a cozy modern coffee shop with glowing warm lights'
];

const ASPECT_RATIOS = [
  { id: '1:1', label: 'Square (1:1)', icon: '▢' },
  { id: '16:9', label: 'Landscape (16:9)', icon: '▭' },
  { id: '9:16', label: 'Portrait (9:16)', icon: '▯' },
  { id: '4:3', label: 'Photo (4:3)', icon: '▱' },
  { id: '3:4', label: 'Tall (3:4)', icon: '▰' }
];

export default function ImagePromptModal({
  isOpen = false,
  onClose,
  onSubmit,
  initialPrompt = '',
  providerConfig = null
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [selectedProvider, setSelectedProvider] = useState('auto');
  const textareaRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setPrompt(initialPrompt);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.select();
        }
      }, 80);
    }
  }, [isOpen, initialPrompt]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    onSubmit({
      prompt: prompt.trim(),
      aspectRatio,
      provider: selectedProvider
    });
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const isGeminiAvailable = Boolean(providerConfig?.geminiConfigured ?? providerConfig?.data?.geminiConfigured);
  const isCloudflareAvailable = Boolean(providerConfig?.cloudflareConfigured ?? providerConfig?.data?.cloudflareConfigured);

  return (
    <div className="modal-backdrop image-prompt-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="image-prompt-modal-container"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <div className="modal-title-wrap">
            <div className="modal-icon-badge">
              <Sparkles size={18} className="text-blue-400" />
            </div>
            <div>
              <h3 className="modal-title">Generate AI Image</h3>
              <p className="modal-subtitle">Create images from detailed text prompts</p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="image-prompt-form">
          <div className="form-group">
            <label htmlFor="image-prompt-input" className="form-label">
              Prompt Description
            </label>
            <textarea
              id="image-prompt-input"
              ref={textareaRef}
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want to see with rich details: subject, style, lighting, colors, background..."
              className="image-prompt-textarea"
              maxLength={2000}
              required
            />
            <div className="prompt-char-count">{prompt.length} / 2000</div>
          </div>

          {/* Quick Starters */}
          <div className="prompt-starters-section">
            <span className="starters-label">Try an example:</span>
            <div className="starters-pills">
              {EXAMPLE_PROMPTS.map((ex, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="starter-pill"
                  onClick={() => setPrompt(ex)}
                >
                  <Wand2 size={11} className="mr-1 inline text-blue-400" />
                  <span>{ex.slice(0, 48)}...</span>
                </button>
              ))}
            </div>
          </div>

          {/* Aspect Ratio Selector */}
          <div className="form-group">
            <label className="form-label">Aspect Ratio</label>
            <div className="aspect-ratio-selector-grid" role="radiogroup">
              {ASPECT_RATIOS.map((ar) => (
                <button
                  key={ar.id}
                  type="button"
                  role="radio"
                  aria-checked={aspectRatio === ar.id}
                  className={`aspect-ratio-chip ${aspectRatio === ar.id ? 'active' : ''}`}
                  onClick={() => setAspectRatio(ar.id)}
                >
                  <span className="aspect-icon">{ar.icon}</span>
                  <span className="aspect-name">{ar.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Provider Selection */}
          <div className="form-group provider-selection-group">
            <label className="form-label">AI Image Provider</label>
            <div className="provider-options-row">
              <button
                type="button"
                className={`provider-chip ${selectedProvider === 'auto' ? 'active' : ''}`}
                onClick={() => setSelectedProvider('auto')}
              >
                Auto (Best Available)
              </button>
              <button
                type="button"
                className={`provider-chip ${selectedProvider === 'gemini' ? 'active' : ''}`}
                onClick={() => setSelectedProvider('gemini')}
              >
                Gemini {isGeminiAvailable && <span className="active-dot" />}
              </button>
              <button
                type="button"
                className={`provider-chip ${selectedProvider === 'cloudflare' ? 'active' : ''}`}
                onClick={() => setSelectedProvider('cloudflare')}
              >
                Cloudflare {isCloudflareAvailable && <span className="active-dot" />}
              </button>
            </div>
          </div>

          <div className="modal-actions-footer">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!prompt.trim()}
              icon={<Sparkles size={15} />}
            >
              Generate Image
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
