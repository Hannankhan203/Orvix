import React, { useMemo } from 'react';
import {
  Cpu,
  Download,
  Loader2,
  Check,
  AlertCircle,
  X,
  RotateCcw,
  Trash2,
  ChevronDown,
  Sparkles
} from 'lucide-react';
import { getAISelectionGuidance } from '../../config/aiGuidance.js';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  getSupportedWebLLMModels
} from '../../services/webllmService.js';

/**
 * Clean, non-blocking status and progress bar for Browser AI (WebLLM).
 * Surfaces real compatibility checks, shard download progress, WebGPU compilation,
 * ready state, model tier selection (Qwen 2.5 1.5B Standard, SmolLM2 360M Compact, SmolLM2 135M Ultra Lightweight), and errors.
 */
export default function BrowserAIStatusBar({
  visible = false,
  isSelectedProvider = false,
  webllmState,
  gpuCheck,
  selectedModelId = DEFAULT_WEBLLM_MODEL_ID,
  onSelectModel,
  onLoadModel,
  onCancelLoad,
  onUnloadModel,
  isOffline = false
}) {
  const modelOptions = useMemo(() => getSupportedWebLLMModels(), []);

  if (!visible) {
    return null;
  }

  const status = webllmState?.status || 'idle';
  const stateModelId = webllmState?.modelId || selectedModelId;
  const progressPercent =
    typeof webllmState?.progressPercent === 'number' && Number.isFinite(webllmState.progressPercent)
      ? Math.min(100, Math.max(0, webllmState.progressPercent))
      : null;
  const rawProgressText = String(webllmState?.progressText || '').trim();
  const errorMessage = webllmState?.error || null;

  const selectedCatalog =
    WEBLLM_MODEL_CATALOG[selectedModelId] || WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID];
  const effectiveSpecCatalog =
    webllmState?.hasShaderF16 === false && selectedCatalog?.f32FallbackModelId
      ? WEBLLM_MODEL_CATALOG[selectedCatalog.f32FallbackModelId] || selectedCatalog
      : selectedCatalog;
  const vramEstimateLabel =
    typeof effectiveSpecCatalog?.vramRequiredMB === 'number' && effectiveSpecCatalog.vramRequiredMB > 0
      ? effectiveSpecCatalog.vramRequiredMB >= 1024
        ? `~${(effectiveSpecCatalog.vramRequiredMB / 1024).toFixed(1)} GB VRAM`
        : `~${Math.ceil(effectiveSpecCatalog.vramRequiredMB / 10) * 10} MB VRAM`
      : null;
  const loadedModelId = webllmState?.loadedModelId || null;
  const isLoadedInGpu = Boolean(loadedModelId && (status === 'ready' || status === 'generating'));
  const activeCatalog =
    (loadedModelId && WEBLLM_MODEL_CATALOG[loadedModelId]) ||
    WEBLLM_MODEL_CATALOG[stateModelId] ||
    selectedCatalog;

  const loadedMatchesSelected =
    isLoadedInGpu &&
    (loadedModelId === selectedModelId ||
      selectedCatalog?.f32FallbackModelId === loadedModelId);

  const isChecking = status === 'checking' || Boolean(gpuCheck?.checking && status === 'idle');
  const isDownloading = status === 'downloading';
  const isInitializingGpu = status === 'loading';
  const isGenerating = status === 'generating';
  const isBusy = isChecking || isDownloading || isInitializingGpu || isGenerating;
  const isGpuUnsupported = gpuCheck?.supported === false;
  const isCached = Boolean(webllmState?.isCached);
  const isUncachedOffline = isOffline && !isCached && !loadedMatchesSelected;

  let tone = 'neutral';
  let statusBadge = null;
  let headline = `${effectiveSpecCatalog.shortLabel} — Browser AI`;
  let detail = '';

  if (isGpuUnsupported) {
    tone = 'error';
    statusBadge = { label: 'Unavailable', variant: 'error' };
    headline = 'WebGPU unavailable on this browser or device';
    detail =
      gpuCheck?.message ||
      'Use Chrome 113+, Edge 113+, or Safari 18+ with hardware acceleration enabled, or switch providers.';
  } else if (isChecking) {
    tone = 'active';
    statusBadge = { label: 'Checking GPU', variant: 'active' };
    headline = 'Checking browser WebGPU compatibility...';
    detail = 'Verifying graphics adapter support on your device.';
  } else if (isDownloading) {
    tone = 'active';
    statusBadge = { label: 'Downloading', variant: 'active' };
    headline = `Downloading ${activeCatalog.shortLabel} to browser cache`;
    detail =
      rawProgressText ||
      `Downloading model weights (~${activeCatalog.estimatedDownloadMB} MB) directly to your browser...`;
  } else if (isInitializingGpu) {
    tone = 'active';
    statusBadge = { label: 'Loading GPU', variant: 'active' };
    headline = `Initializing ${activeCatalog.shortLabel} in GPU memory`;
    detail = rawProgressText || 'Compiling WebGPU shaders and loading cached weights...';
  } else if (status === 'error') {
    tone = 'error';
    statusBadge = { label: 'Error', variant: 'error' };
    headline = `${activeCatalog.shortLabel} failed to load`;
    detail =
      errorMessage ||
      (selectedCatalog.id === SMOLLM2_135M_WEBLLM_MODEL_ID ||
      selectedCatalog.id === SMOLLM2_360M_WEBLLM_MODEL_ID ||
      selectedCatalog.id === QWEN3_06B_WEBLLM_MODEL_ID
        ? 'Model download or WebGPU initialization failed. Check your internet connection and browser storage, then click Retry.'
        : 'Model download or WebGPU initialization failed. Check storage/GPU memory or try a smaller model (SmolLM2 360M/135M or Qwen3 0.6B).');
  } else if (loadedMatchesSelected) {
    tone = 'ready';
    statusBadge = {
      label: isGenerating ? 'Generating' : isOffline ? 'Offline Ready' : 'Ready',
      variant: isGenerating ? 'active' : 'ready'
    };
    headline = `${activeCatalog.shortLabel} — Ready on device`;
    detail = isGenerating
      ? 'Generating response locally via WebGPU (no server or API calls).'
      : 'Running locally in your browser via WebGPU. Cached for repeat use.';
  } else if (isLoadedInGpu && !loadedMatchesSelected) {
    tone = isUncachedOffline ? 'warning' : 'neutral';
    statusBadge = isCached
      ? { label: 'Cached', variant: 'ready' }
      : isOffline
      ? { label: 'Offline • Not Cached', variant: 'warning' }
      : { label: 'Switch Model', variant: 'neutral' };
    headline = `${selectedCatalog.shortLabel} selected`;
    detail = `${activeCatalog.shortLabel} is currently loaded in GPU memory. Click "${isCached ? 'Load Model' : 'Download & Load'}" or send a message to switch.`;
  } else if (isUncachedOffline) {
    tone = 'warning';
    statusBadge = { label: 'Offline • Not Cached', variant: 'warning' };
    headline = `${effectiveSpecCatalog.shortLabel} — Browser AI`;
    detail = `Offline — Initial download (~${effectiveSpecCatalog.estimatedDownloadMB} MB) requires an internet connection before offline use.`;
  } else {
    tone = isCached ? 'ready' : 'neutral';
    statusBadge = isCached
      ? { label: isOffline ? 'Offline Cached' : 'Cached', variant: 'ready' }
      : { label: 'Not Downloaded', variant: 'neutral' };
    headline = `${effectiveSpecCatalog.shortLabel} — Browser AI`;
    detail = isOffline
      ? 'Offline — Model is cached locally. Click Load Model or send a message to run on your device via WebGPU.'
      : isCached
      ? 'Model weights are cached in your browser. Click Load Model or send a message to initialize WebGPU.'
      : `Runs locally via WebGPU (no API key${vramEstimateLabel ? `, ${vramEstimateLabel}` : ''}). First use downloads and caches ~${effectiveSpecCatalog.estimatedDownloadMB} MB on your device.`;
  }

  const showProgressBar = isDownloading || isInitializingGpu;

  return (
    <div
      className={`browser-ai-status-bar tone-${tone}`}
      role="status"
      aria-live="polite"
    >
      <div className="browser-ai-status-main">
        <div className="browser-ai-status-lead">
          <span className={`browser-ai-icon-wrap tone-${tone}`} aria-hidden="true">
            {isChecking || isInitializingGpu || isGenerating ? (
              <Loader2 size={14} className="spin-icon" />
            ) : isDownloading ? (
              <Download size={14} />
            ) : tone === 'error' || tone === 'warning' ? (
              <AlertCircle size={14} />
            ) : tone === 'ready' ? (
              <Check size={14} />
            ) : (
              <Cpu size={14} />
            )}
          </span>

          <div className="browser-ai-copy">
            <div className="browser-ai-headline-row">
              <span className="browser-ai-headline">{headline}</span>
              {statusBadge && (
                <span className={`browser-ai-status-badge badge-${statusBadge.variant}`}>
                  {statusBadge.label}
                </span>
              )}
              {showProgressBar && progressPercent !== null && (
                <span className="browser-ai-percent" aria-label={`${progressPercent} percent`}>
                  {progressPercent}%
                </span>
              )}
              {!isSelectedProvider && showProgressBar && (
                <span className="browser-ai-bg-note">Background load</span>
              )}
            </div>
            {detail && (
              <p className="browser-ai-detail" title={rawProgressText || detail}>
                {detail}
              </p>
            )}
            {isSelectedProvider && (
              <p
                id="browser-ai-model-guidance-desc"
                className="browser-ai-guidance-note"
                role="note"
              >
                <Sparkles size={11} className="browser-ai-guidance-icon" aria-hidden="true" />
                <span>{getAISelectionGuidance('webllm', selectedModelId)}</span>
              </p>
            )}
          </div>
        </div>

        <div className="browser-ai-controls">
          {isSelectedProvider && !isGpuUnsupported && modelOptions.length > 1 && (
            <div className="browser-ai-model-picker" title="Choose local Browser AI model size">
              <select
                aria-label="Browser AI model size"
                className="browser-ai-model-select"
                value={selectedModelId}
                disabled={isBusy}
                onChange={(e) => onSelectModel && onSelectModel(e.target.value)}
                aria-describedby="browser-ai-model-guidance-desc"
              >
                <optgroup label="Browser AI Models">
                  {modelOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {`${opt.shortLabel} — ${opt.tierLabel || (opt.tier === 'ultra-lightweight' ? 'Ultra Lightweight' : opt.tier === 'lightweight' ? 'Lightweight' : 'Standard')} (~${opt.estimatedDownloadMB} MB)`}
                    </option>
                  ))}
                </optgroup>
              </select>
              <ChevronDown size={11} className="browser-ai-select-chevron" aria-hidden="true" />
            </div>
          )}

          {(isDownloading || isInitializingGpu) && onCancelLoad && (
            <button
              type="button"
              className="browser-ai-action-btn secondary"
              onClick={() => onCancelLoad()}
              title="Cancel model download or initialization"
            >
              <X size={12} />
              <span>Cancel</span>
            </button>
          )}

          {!isBusy && !isGpuUnsupported && status === 'error' && onLoadModel && (
            <button
              type="button"
              className="browser-ai-action-btn primary"
              onClick={() => onLoadModel()}
              disabled={isUncachedOffline}
              title={
                isUncachedOffline
                  ? 'Connect to the internet to download model weights'
                  : 'Retry Browser AI download and initialization'
              }
            >
              <RotateCcw size={12} />
              <span>Retry</span>
            </button>
          )}

          {!isBusy && !isGpuUnsupported && status !== 'error' && !loadedMatchesSelected && isSelectedProvider && onLoadModel && (
            <button
              type="button"
              className="browser-ai-action-btn primary"
              onClick={() => onLoadModel()}
              disabled={isUncachedOffline}
              title={
                isUncachedOffline
                  ? `Connect to the internet once to download ${effectiveSpecCatalog.shortLabel} (~${effectiveSpecCatalog.estimatedDownloadMB} MB)`
                  : isCached
                  ? `Load cached ${effectiveSpecCatalog.shortLabel} into browser WebGPU memory`
                  : `Download and load ${effectiveSpecCatalog.shortLabel} (~${effectiveSpecCatalog.estimatedDownloadMB} MB) into browser WebGPU memory`
              }
            >
              <Download size={12} />
              <span>{isCached ? 'Load Model' : isOffline ? 'Requires Internet' : 'Download & Load'}</span>
            </button>
          )}

          {loadedMatchesSelected && !isGenerating && isSelectedProvider && onUnloadModel && (
            <button
              type="button"
              className="browser-ai-action-btn ghost"
              onClick={() => onUnloadModel()}
              title="Unload model from GPU memory (keeps browser cache intact)"
            >
              <Trash2 size={12} />
              <span>Unload</span>
            </button>
          )}
        </div>
      </div>

      {showProgressBar && (
        <div
          className={`browser-ai-progress-track ${progressPercent === null ? 'indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent !== null ? progressPercent : undefined}
          aria-label={headline}
        >
          <div
            className="browser-ai-progress-fill"
            style={progressPercent !== null ? { width: `${progressPercent}%` } : undefined}
          />
        </div>
      )}
    </div>
  );
}
