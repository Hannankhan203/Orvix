import React, { useState, useEffect } from 'react';
import {
  Download,
  Eye,
  Maximize2,
  Copy,
  Check,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Loader2,
  Layers,
  FileImage,
  ExternalLink
} from 'lucide-react';
import Button from '../ui/Button.jsx';
import { downloadGeneratedImage } from '../../services/imageGenerationService.js';
import { getAttachmentBlob } from '../../services/attachmentStorageService.js';
const DocumentPreviewModal = React.lazy(() => import('./DocumentPreviewModal.jsx'));

/**
 * GeneratedImageCard Component
 * Dedicated interactive card for generated multimodal AI images.
 * Supports loading shimmer, full-size preview, metadata badges,
 * one-click original format download, and comprehensive error states.
 */
export default function GeneratedImageCard({
  imageResult = null,
  prompt = '',
  status = 'ready', // 'generating' | 'ready' | 'error'
  error = null,
  provider = 'gemini',
  model = null,
  aspectRatio = '1:1',
  elapsedSec = 0,
  onRetry = null,
  className = ''
}) {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [localBlobUrl, setLocalBlobUrl] = useState(null);

  // Hydrate image binary from local IndexedDB if memory base64 was stripped for storage
  useEffect(() => {
    let active = true;
    let objectUrl = null;

    if (!imageResult?.dataUrl && !imageResult?.base64 && imageResult?.id) {
      getAttachmentBlob(imageResult.id)
        .then((blob) => {
          if (active && blob) {
            objectUrl = URL.createObjectURL(blob);
            setLocalBlobUrl(objectUrl);
          }
        })
        .catch(() => {});
    }

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [imageResult?.id, imageResult?.dataUrl, imageResult?.base64]);

  const effectivePrompt = imageResult?.prompt || prompt || '';
  const effectiveProvider = imageResult?.provider || provider || 'gemini';
  const effectiveModel = imageResult?.model || model || (effectiveProvider === 'gemini' ? 'gemini-3.1-flash-lite-image' : 'flux-1-schnell');
  const chatIdQuery = imageResult?.conversationId ? `?chatId=${encodeURIComponent(imageResult.conversationId)}` : '';
  const effectiveDataUrl =
    localBlobUrl ||
    imageResult?.dataUrl ||
    (imageResult?.base64
      ? `data:${imageResult.mimeType || 'image/png'};base64,${imageResult.base64}`
      : imageResult?.url ||
        (imageResult?.id ? `/api/image/${imageResult.id}/file${chatIdQuery}` : null) ||
        (imageResult?.id ? `/api/upload/${imageResult.id}/file${chatIdQuery}` : null));
  const effectiveDimensions = imageResult?.dimensions;
  const effectiveFormat = (imageResult?.format || (imageResult?.mimeType || '').split('/')[1] || 'png').toUpperCase();
  const effectiveAspectRatio = imageResult?.aspectRatio || aspectRatio || '1:1';

  const handleCopyPrompt = async (e) => {
    e.stopPropagation();
    if (!effectivePrompt) return;
    try {
      await navigator.clipboard.writeText(effectivePrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch (_) {}
  };

  const handleDownload = (e) => {
    e.stopPropagation();
    if (downloading || !imageResult) return;
    setDownloading(true);
    try {
      const ok = downloadGeneratedImage(imageResult);
      if (!ok) {
        console.warn('Direct download returned false, checking fallback');
      }
    } finally {
      setTimeout(() => setDownloading(false), 500);
    }
  };

  // 1. Loading / Generating State
  if (status === 'generating') {
    return (
      <div className={`generated-image-card is-loading ${className}`} role="status" aria-live="polite">
        <div className="generated-image-skeleton">
          <div className="skeleton-aspect-box" style={{ aspectRatio: effectiveAspectRatio.replace(':', '/') }}>
            <div className="skeleton-shimmer" />
            <div className="skeleton-overlay-content">
              <div className="skeleton-spinner-wrap">
                <Loader2 size={28} className="animate-spin text-blue-400" />
                <Sparkles size={16} className="skeleton-sparkle-icon" />
              </div>
              <p className="skeleton-label">Generating image with {effectiveProvider === 'cloudflare' ? 'Cloudflare Workers AI' : 'Gemini'}...</p>
              {elapsedSec > 0 && (
                <span className="skeleton-elapsed-badge">{elapsedSec}s</span>
              )}
            </div>
          </div>
        </div>

        <div className="generated-image-footer">
          <div className="generated-prompt-preview">
            <span className="prompt-label">Prompt:</span>
            <span className="prompt-text">"{effectivePrompt}"</span>
          </div>
          <div className="generated-meta-tags">
            <span className="meta-tag provider-tag">{effectiveProvider}</span>
            <span className="meta-tag aspect-tag">{effectiveAspectRatio}</span>
          </div>
        </div>
      </div>
    );
  }

  // 2. Error State (Unavailable provider, Quota, Blocked prompt, or Timeout)
  if (status === 'error' || error) {
    const errorMsg = error?.message || (typeof error === 'string' ? error : 'Image generation is currently unavailable.');
    const isQuota = errorMsg.includes('quota') || errorMsg.includes('RESOURCE_EXHAUSTED') || error?.code === 'QUOTA_EXCEEDED';
    const isUnconfigured = errorMsg.includes('not configured') || errorMsg.includes('PROVIDER_NOT_CONFIGURED') || error?.code === 'PROVIDER_NOT_CONFIGURED';
    const isSafety = errorMsg.includes('safety') || error?.code === 'SAFETY_VIOLATION';
    const isTimeout = errorMsg.includes('timed out') || error?.code === 'DEADLINE_EXCEEDED';

    return (
      <div className={`generated-image-card is-error ${className}`} role="alert">
        <div className="generated-error-header">
          <div className="error-icon-box">
            <AlertTriangle size={20} className="text-amber-400" />
          </div>
          <div className="error-text-content">
            <h4 className="error-title">
              {isUnconfigured
                ? 'Image Generation Provider Unavailable'
                : isQuota
                ? 'Image Generation Quota Reached'
                : isSafety
                ? 'Prompt Blocked by Safety Filters'
                : isTimeout
                ? 'Image Generation Timed Out'
                : 'Image Generation Failed'}
            </h4>
            <p className="error-description">{errorMsg}</p>
          </div>
        </div>

        {effectivePrompt && (
          <div className="failed-prompt-box">
            <span className="failed-prompt-label">Attempted prompt:</span>
            <p className="failed-prompt-text">"{effectivePrompt}"</p>
          </div>
        )}

        {onRetry && (
          <div className="error-action-row">
            <Button
              variant="outline"
              size="sm"
              icon={<RotateCcw size={13} />}
              onClick={onRetry}
            >
              Retry Generation
            </Button>
          </div>
        )}
      </div>
    );
  }

  // 3. Success / Ready State
  return (
    <>
      <div className={`generated-image-card is-ready ${className}`}>
        {/* Main Image Container */}
        <div
          className="generated-image-viewport"
          onClick={() => setPreviewOpen(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPreviewOpen(true);
            }
          }}
          title="Click to view full size"
          aria-label={`Generated image for: ${effectivePrompt}`}
        >
          {!imageLoaded && !imageError && (
            <div className="image-loading-placeholder">
              <Loader2 size={24} className="animate-spin text-blue-400" />
            </div>
          )}

          {effectiveDataUrl && !imageError ? (
            <img
              src={effectiveDataUrl}
              alt={effectivePrompt || 'AI Generated Image'}
              className={`generated-image-media ${imageLoaded ? 'is-visible' : 'is-hidden'}`}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageError(true)}
              loading="lazy"
            />
          ) : (
            <div className="image-fallback-container">
              <FileImage size={32} className="text-gray-400" />
              <span>Image preview unavailable</span>
            </div>
          )}

          {/* Hover Overlay with View Larger indicator */}
          <div className="generated-image-overlay" aria-hidden="true">
            <div className="overlay-badge">
              <Maximize2 size={13} />
              <span>View Larger</span>
            </div>
          </div>
        </div>

        {/* Card Details & Actions Footer */}
        <div className="generated-image-footer">
          <div className="generated-prompt-row">
            <p className="generated-prompt-display" title={effectivePrompt}>
              "{effectivePrompt}"
            </p>
            <button
              type="button"
              className="copy-prompt-btn"
              onClick={handleCopyPrompt}
              title="Copy prompt text"
              aria-label="Copy prompt"
            >
              {copiedPrompt ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </button>
          </div>

          <div className="generated-meta-bar">
            <div className="meta-badges-group">
              <span className="meta-badge provider-badge" title={`Provider: ${effectiveProvider}`}>
                <Sparkles size={11} className="mr-1 inline text-blue-400" />
                {effectiveProvider === 'cloudflare' ? 'Cloudflare' : 'Gemini'}
              </span>

              {effectiveModel && (
                <span className="meta-badge model-badge" title={`Model: ${effectiveModel}`}>
                  {effectiveModel}
                </span>
              )}

              <span className="meta-badge format-badge">
                {effectiveFormat}
              </span>

              {effectiveDimensions?.width && effectiveDimensions?.height ? (
                <span className="meta-badge dim-badge">
                  {effectiveDimensions.width}×{effectiveDimensions.height}
                </span>
              ) : (
                <span className="meta-badge aspect-badge">
                  {effectiveAspectRatio}
                </span>
              )}
            </div>

            <div className="generated-actions-group">
              <button
                type="button"
                className="action-btn download-btn"
                onClick={handleDownload}
                disabled={downloading}
                title={`Download ${effectiveFormat} image`}
                aria-label={`Download image in original ${effectiveFormat} format`}
              >
                {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                <span className="btn-label">Download</span>
              </button>

              <button
                type="button"
                className="action-btn preview-btn"
                onClick={() => setPreviewOpen(true)}
                title="View full-size modal"
                aria-label="View full-size modal"
              >
                <Eye size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Larger View Modal */}
      {previewOpen && (
        <React.Suspense fallback={null}>
          <DocumentPreviewModal
            isOpen={previewOpen}
            onClose={() => setPreviewOpen(false)}
            attachment={{
              id: imageResult?.id,
              name: imageResult?.filename || `${effectivePrompt.slice(0, 20)}.png`,
              originalName: imageResult?.filename || `${effectivePrompt.slice(0, 20)}.png`,
              dataUrl: effectiveDataUrl,
              previewUrl: effectiveDataUrl,
              isImage: true,
              extension: `.${effectiveFormat.toLowerCase()}`,
              mimeType: imageResult?.mimeType || 'image/png',
              size: imageResult?.size || 0,
              type: imageResult?.mimeType || 'image/png'
            }}
          />
        </React.Suspense>
      )}
    </>
  );
}
