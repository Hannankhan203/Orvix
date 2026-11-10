import React from 'react';
import { Eye, X, FileImage } from 'lucide-react';

/**
 * ComposerAttachmentTray Component
 * Renders the preview chip for the selected file or image attachment inside the composer dock.
 */
export default function ComposerAttachmentTray({
  attachments = [],
  onPreview,
  onRemove
}) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="composer-attachments-preview" role="region" aria-label="Selected attachment">
      {attachments.map((att) =>
        att.isImage ? (
          <div
            key={att.id}
            className="composer-attachment-chip composer-image-chip is-previewable"
            title={`Click to preview ${att.name} (${att.extension || 'IMG'} • ${att.formattedSize})`}
            onClick={() => onPreview && onPreview(att)}
          >
            <div className="composer-image-thumb-wrap">
              {att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="composer-image-thumb"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    const fallback = e.currentTarget.parentElement?.querySelector(
                      '.composer-image-fallback-icon'
                    );
                    if (fallback) fallback.style.display = 'flex';
                  }}
                />
              ) : null}
              <div
                className="composer-image-fallback-icon"
                style={{ display: att.previewUrl ? 'none' : 'flex' }}
                aria-hidden="true"
              >
                <FileImage size={16} />
              </div>
            </div>
            <div className="composer-image-meta">
              <span className="attachment-chip-name" title={att.name}>
                {att.name}
              </span>
              <div className="attachment-chip-submeta">
                <span className="attachment-chip-badge">{att.extension || 'IMG'}</span>
                <span className="attachment-chip-size">{att.formattedSize}</span>
                {typeof att.uploadProgress === 'number' && att.uploadProgress < 100 ? (
                  <span className="attachment-chip-progress text-xs font-mono text-blue-400 font-medium">
                    {Math.round(att.uploadProgress)}%
                  </span>
                ) : null}
              </div>
            </div>
            {typeof att.uploadProgress === 'number' && att.uploadProgress < 100 ? (
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-500/20 overflow-hidden rounded-b">
                <div
                  className="h-full bg-blue-500 transition-all duration-150 ease-out"
                  style={{ width: `${Math.round(att.uploadProgress)}%` }}
                />
              </div>
            ) : null}
            <div className="composer-chip-actions">
              <button
                type="button"
                className="attachment-chip-preview"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview && onPreview(att);
                }}
                title={`Preview ${att.name}`}
                aria-label={`Preview attachment ${att.name}`}
              >
                <Eye size={14} />
              </button>
              <button
                type="button"
                className="attachment-chip-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove && onRemove(att.id);
                }}
                title={`Remove ${att.name}`}
                aria-label={`Remove attachment ${att.name}`}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div
            key={att.id}
            className="composer-attachment-chip is-previewable relative overflow-hidden"
            title={`Click to preview ${att.name} (${att.extension || 'FILE'} • ${att.formattedSize})`}
            onClick={() => onPreview && onPreview(att)}
          >
            <span className="attachment-chip-badge">{att.extension || 'FILE'}</span>
            <span className="attachment-chip-name" title={att.name}>
              {att.name}
            </span>
            <span className="attachment-chip-size">{att.formattedSize}</span>
            {typeof att.uploadProgress === 'number' && att.uploadProgress < 100 ? (
              <span className="attachment-chip-progress text-xs font-mono text-blue-400 font-medium">
                {Math.round(att.uploadProgress)}%
              </span>
            ) : null}
            {typeof att.uploadProgress === 'number' && att.uploadProgress < 100 ? (
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-500/20 overflow-hidden rounded-b">
                <div
                  className="h-full bg-blue-500 transition-all duration-150 ease-out"
                  style={{ width: `${Math.round(att.uploadProgress)}%` }}
                />
              </div>
            ) : null}
            <div className="composer-chip-actions">
              <button
                type="button"
                className="attachment-chip-preview"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview && onPreview(att);
                }}
                title={`Preview ${att.name}`}
                aria-label={`Preview attachment ${att.name}`}
              >
                <Eye size={14} />
              </button>
              <button
                type="button"
                className="attachment-chip-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove && onRemove(att.id);
                }}
                title={`Remove ${att.name}`}
                aria-label={`Remove attachment ${att.name}`}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
