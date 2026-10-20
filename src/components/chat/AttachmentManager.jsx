import React from 'react';
import {
  FileText,
  Presentation,
  Table,
  Code,
  FileCode,
  File,
  Image as ImageIcon,
  X,
  Loader2,
  Check,
  AlertCircle
} from 'lucide-react';
import { formatFileSize, getFileExtension } from '../../utils/documentExtractor.js';

/**
 * Returns icon component matching document extension
 */
function getDocumentIcon(filename = '') {
  const ext = getFileExtension(filename);
  switch (ext) {
    case '.pdf':
      return <FileText size={15} className="doc-icon-svg pdf-color" />;
    case '.docx':
      return <FileText size={15} className="doc-icon-svg docx-color" />;
    case '.pptx':
      return <Presentation size={15} className="doc-icon-svg pptx-color" />;
    case '.csv':
      return <Table size={15} className="doc-icon-svg csv-color" />;
    case '.json':
      return <Code size={15} className="doc-icon-svg json-color" />;
    case '.md':
      return <FileCode size={15} className="doc-icon-svg md-color" />;
    case '.txt':
    default:
      return <File size={15} className="doc-icon-svg txt-color" />;
  }
}

/**
 * AttachmentManager Component
 * Renders compact, accessible preview chips for staged documents and images above the composer.
 * Provides clear visual distinction between images (with thumbnails) and documents.
 *
 * @param {Object} props
 * @param {Array<Object>} props.attachments - Staged attachments (images and documents)
 * @param {(id: string) => void} props.onRemove - Callback to remove attachment
 * @param {string|null} [props.attachmentError=null] - Global attachment error message
 * @param {() => void} [props.onClearError] - Callback to clear attachment error
 */
export default function AttachmentManager({
  attachments = [],
  onRemove,
  attachmentError = null,
  onClearError
}) {
  if (attachments.length === 0 && !attachmentError) {
    return null;
  }

  return (
    <div className="attachments-dock-wrapper" role="region" aria-label="Attached files">
      {/* Error alert banner */}
      {attachmentError && (
        <div className="attachment-error-banner" role="alert">
          <div className="attachment-error-content">
            <AlertCircle size={14} className="attachment-error-icon" />
            <span className="attachment-error-msg">{attachmentError}</span>
          </div>
          {onClearError && (
            <button
              type="button"
              className="attachment-error-dismiss"
              onClick={onClearError}
              aria-label="Dismiss error"
              title="Dismiss error"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* List of active attachment chips */}
      {attachments.length > 0 && (
        <div className="attachment-chips-list">
          {attachments.map((item) => {
            const isImage =
              item.category === 'image' ||
              Boolean(item.previewUrl) ||
              Boolean(item.mimeType?.startsWith('image/')) ||
              Boolean(item.type?.startsWith('image/'));

            const isProcessing = item.status === 'extracting' || item.status === 'processing';
            const isError = item.status === 'error';
            const isReady = item.status === 'ready' || (!item.status && (item.text || item.dataUrl || item.previewUrl));

            if (isImage) {
              const formatLabel = (item.type || item.mimeType || 'IMAGE')
                .replace(/^image\//i, '')
                .toUpperCase();

              const dimBadge = item.width && item.height ? `${item.width}×${item.height}` : null;

              return (
                <div
                  key={item.id}
                  className={`attachment-chip attachment-chip-image ${isProcessing ? 'is-extracting' : ''} ${isError ? 'is-error' : ''} ${isReady ? 'is-ready' : ''}`}
                  title={item.error || `${item.name} (${formatFileSize(item.size)})`}
                >
                  <div className="attachment-image-thumb-wrapper" aria-hidden="true">
                    {item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt={item.name}
                        className="attachment-image-thumb"
                      />
                    ) : (
                      <ImageIcon size={18} className="text-violet-400" />
                    )}
                    <span className="attachment-image-type-badge">{formatLabel}</span>
                  </div>

                  <div className="attachment-chip-info">
                    <div className="attachment-chip-top">
                      <span className="attachment-chip-name">{item.name}</span>
                    </div>

                    <div className="attachment-chip-meta">
                      <span className="attachment-chip-size">{formatFileSize(item.size)}</span>
                      {dimBadge && <span className="attachment-chip-submeta">• {dimBadge}</span>}

                      {isProcessing && (
                        <span className="attachment-chip-status extracting">
                          <Loader2 size={11} className="spin-icon" />
                          <span>Verifying...</span>
                        </span>
                      )}

                      {isReady && (
                        <span className="attachment-chip-status ready" title="Ready to send with your message">
                          <Check size={11} />
                          <span>Ready</span>
                        </span>
                      )}

                      {isError && (
                        <span className="attachment-chip-status error" title={item.error}>
                          <AlertCircle size={11} />
                          <span>Failed</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="attachment-chip-remove"
                    onClick={() => onRemove && onRemove(item.id)}
                    title={`Remove ${item.name}`}
                    aria-label={`Remove image ${item.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            }

            // Document Attachment Chip
            const metaBadge = item.pageCount
              ? `${item.pageCount} p.`
              : item.slideCount
              ? `${item.slideCount} slides`
              : item.rowCount
              ? `${item.rowCount} rows`
              : null;

            return (
              <div
                key={item.id}
                className={`attachment-chip ${isProcessing ? 'is-extracting' : ''} ${isError ? 'is-error' : ''} ${isReady ? 'is-ready' : ''}`}
                title={item.error || item.name}
              >
                <div className="attachment-chip-icon" aria-hidden="true">
                  {getDocumentIcon(item.name)}
                </div>

                <div className="attachment-chip-info">
                  <div className="attachment-chip-top">
                    <span className="attachment-chip-name">{item.name}</span>
                  </div>

                  <div className="attachment-chip-meta">
                    <span className="attachment-chip-size">{formatFileSize(item.size)}</span>
                    {metaBadge && <span className="attachment-chip-submeta">• {metaBadge}</span>}

                    {isProcessing && (
                      <span className="attachment-chip-status extracting">
                        <Loader2 size={11} className="spin-icon" />
                        <span>Reading...</span>
                      </span>
                    )}

                    {isReady && (
                      <span className="attachment-chip-status ready" title="Ready to send with your message">
                        <Check size={11} />
                        <span>Ready</span>
                      </span>
                    )}

                    {isError && (
                      <span className="attachment-chip-status error" title={item.error}>
                        <AlertCircle size={11} />
                        <span>Failed</span>
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className="attachment-chip-remove"
                  onClick={() => onRemove && onRemove(item.id)}
                  title={`Remove ${item.name}`}
                  aria-label={`Remove document ${item.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
