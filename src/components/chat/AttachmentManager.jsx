import React from 'react';
import {
  FileText,
  Presentation,
  Table,
  Code,
  FileCode,
  File,
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
 * Renders compact, accessible preview chips for staged documents above the composer.
 *
 * @param {Object} props
 * @param {Array<Object>} props.attachments - Staged attachments
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
    <div className="attachments-dock-wrapper" role="region" aria-label="Attached documents">
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
          {attachments.map((doc) => {
            const isExtracting = doc.status === 'extracting';
            const isError = doc.status === 'error';
            const isReady = doc.status === 'ready' || (!doc.status && doc.text);

            const metaBadge = doc.pageCount
              ? `${doc.pageCount} p.`
              : doc.slideCount
              ? `${doc.slideCount} slides`
              : doc.rowCount
              ? `${doc.rowCount} rows`
              : null;

            return (
              <div
                key={doc.id}
                className={`attachment-chip ${isExtracting ? 'is-extracting' : ''} ${isError ? 'is-error' : ''} ${isReady ? 'is-ready' : ''}`}
                title={doc.error || doc.name}
              >
                <div className="attachment-chip-icon" aria-hidden="true">
                  {getDocumentIcon(doc.name)}
                </div>

                <div className="attachment-chip-info">
                  <div className="attachment-chip-top">
                    <span className="attachment-chip-name">{doc.name}</span>
                  </div>

                  <div className="attachment-chip-meta">
                    <span className="attachment-chip-size">{formatFileSize(doc.size)}</span>
                    {metaBadge && <span className="attachment-chip-submeta">• {metaBadge}</span>}

                    {isExtracting && (
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
                      <span className="attachment-chip-status error" title={doc.error}>
                        <AlertCircle size={11} />
                        <span>Failed</span>
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className="attachment-chip-remove"
                  onClick={() => onRemove && onRemove(doc.id)}
                  title={`Remove ${doc.name}`}
                  aria-label={`Remove ${doc.name}`}
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
