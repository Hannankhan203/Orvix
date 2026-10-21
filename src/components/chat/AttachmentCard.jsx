import React, { useState, useEffect } from 'react';
import {
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  Download,
  Eye,
  AlertTriangle,
  Loader2,
  ExternalLink
} from 'lucide-react';
import {
  isFormatPreviewable,
  openOrPreviewAttachment,
  downloadAttachmentFile,
  checkAttachmentStatus
} from '../../services/attachmentStorageService.js';
import DocumentPreviewModal from './DocumentPreviewModal.jsx';

/**
 * Returns an appropriate icon component for a given file extension
 */
function getFormatIcon(ext = '') {
  const cleanExt = (ext || '').replace('.', '').toLowerCase();
  switch (cleanExt) {
    case 'pdf':
      return FileText;
    case 'doc':
    case 'docx':
      return FileText;
    case 'ppt':
    case 'pptx':
      return FileText;
    case 'xls':
    case 'xlsx':
    case 'csv':
    case 'tsv':
      return FileSpreadsheet;
    case 'md':
    case 'markdown':
    case 'json':
    case 'xml':
    case 'txt':
      return FileCode;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'svg':
      return FileImage;
    default:
      return FileText;
  }
}

/**
 * Returns a CSS class modifier for the format badge
 */
function getFormatBadgeClass(ext = '') {
  const cleanExt = (ext || '').replace('.', '').toLowerCase();
  switch (cleanExt) {
    case 'pdf':
      return 'format-pdf';
    case 'doc':
    case 'docx':
      return 'format-doc';
    case 'ppt':
    case 'pptx':
      return 'format-ppt';
    case 'xls':
    case 'xlsx':
    case 'csv':
    case 'tsv':
      return 'format-sheet';
    case 'md':
    case 'markdown':
    case 'txt':
    case 'json':
    case 'xml':
      return 'format-text';
    default:
      return 'format-default';
  }
}

/**
 * Formats byte size safely if not pre-formatted
 */
function formatSize(size, formattedSize) {
  if (formattedSize) return formattedSize;
  if (!size || size <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * AttachmentCard Component
 * Displays an uploaded file with filename, type, size, and provides in-browser preview / download.
 *
 * @param {Object} props
 * @param {Object} props.attachment - Attachment metadata object
 * @param {boolean} [props.compact=false] - Compact mode for assistant reference headers
 * @param {boolean} [props.showActions=true] - Whether to show hover action buttons
 * @param {string} [props.className='']
 */
export default function AttachmentCard({
  attachment,
  compact = false,
  showActions = true,
  className = ''
}) {
  const [loading, setLoading] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (!attachment) return null;

  const filename = attachment.name || attachment.originalName || 'Document';
  const ext = (attachment.extension || '').toUpperCase() || 'FILE';
  const sizeText = formatSize(attachment.size, attachment.formattedSize);
  const canPreview = isFormatPreviewable(attachment.extension, attachment.type || attachment.mimeType);
  const IconComponent = getFormatIcon(attachment.extension);
  const formatBadgeClass = getFormatBadgeClass(attachment.extension);

  // Auto-dismiss transient notice
  useEffect(() => {
    if (!noticeMessage) return;
    const timer = setTimeout(() => setNoticeMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [noticeMessage]);

  // Gracefully verify attachment availability on mount (handles page refresh & reopened conversations)
  useEffect(() => {
    let isMounted = true;
    if (!attachment?.id) return;

    checkAttachmentStatus(attachment).then((status) => {
      if (isMounted && !status.available) {
        setIsUnavailable(true);
      }
    }).catch(() => {
      // Keep current state on network hiccups
    });

    return () => {
      isMounted = false;
    };
  }, [attachment?.id]);

  const handleCardClick = async (e) => {
    // If a sub-button was clicked, let its handler handle it
    if (e.target.closest('.attachment-action-btn')) {
      return;
    }

    if (loading) return;

    if (isUnavailable) {
      setNoticeMessage('This attachment has expired or is no longer stored on the server.');
      return;
    }

    // If format is previewable, open in-app modal preview
    if (canPreview || attachment.extraction?.text) {
      setPreviewOpen(true);
      return;
    }

    // Otherwise download original file
    setLoading(true);
    try {
      const result = await downloadAttachmentFile(attachment);
      if (!result.success) {
        setIsUnavailable(true);
        setNoticeMessage(result.error || 'This attachment is no longer available.');
      }
    } catch (err) {
      setIsUnavailable(true);
      setNoticeMessage('Unable to open attachment.');
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = (e) => {
    e.stopPropagation();
    if (isUnavailable) {
      setNoticeMessage('This attachment has expired.');
      return;
    }
    setPreviewOpen(true);
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (loading) return;

    if (isUnavailable) {
      setNoticeMessage('This attachment has expired.');
      return;
    }

    setLoading(true);
    try {
      const result = await downloadAttachmentFile(attachment);
      if (!result.success) {
        setIsUnavailable(true);
        setNoticeMessage(result.error || 'This attachment is no longer available for download.');
      }
    } catch (_) {
      setIsUnavailable(true);
      setNoticeMessage('Unable to download attachment.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="attachment-card-wrapper relative">
      <div
        className={`message-attachment-card ${compact ? 'is-compact' : ''} ${isUnavailable ? 'is-unavailable' : ''} ${className}`}
        onClick={handleCardClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCardClick(e);
          }
        }}
        title={
          isUnavailable
            ? `${filename} (Unavailable / Expired)`
            : `${filename}${sizeText ? ` • ${sizeText}` : ''} — Click to ${canPreview ? 'preview' : 'download'}`
        }
        aria-label={`${filename}, ${ext} file${sizeText ? `, ${sizeText}` : ''}${isUnavailable ? ', unavailable' : ''}`}
      >
        <div className={`message-attachment-icon-badge ${formatBadgeClass}`}>
          {isUnavailable ? (
            <AlertTriangle size={13} className="text-amber-400" aria-hidden="true" />
          ) : loading ? (
            <Loader2 size={13} className="animate-spin text-blue-400" aria-hidden="true" />
          ) : (
            <IconComponent size={13} className="attachment-type-icon" aria-hidden="true" />
          )}
          <span className="attachment-ext-tag">{ext}</span>
        </div>

        <div className="message-attachment-details">
          <span className="message-attachment-name" title={filename}>
            {filename}
          </span>
          <span className="message-attachment-size">
            {isUnavailable ? 'Unavailable' : sizeText || 'Document'}
          </span>
        </div>

        {showActions && !isUnavailable && (
          <div className="attachment-card-actions" onClick={(e) => e.stopPropagation()}>
            {(canPreview || attachment.extraction?.text) && (
              <button
                type="button"
                className="attachment-action-btn"
                onClick={handlePreview}
                title={`Preview ${filename}`}
                aria-label={`Preview ${filename}`}
                disabled={loading}
              >
                <Eye size={12} />
              </button>
            )}
            <button
              type="button"
              className="attachment-action-btn"
              onClick={handleDownload}
              title={`Download original ${filename}`}
              aria-label={`Download original ${filename}`}
              disabled={loading}
            >
              <Download size={12} />
            </button>
          </div>
        )}
      </div>

      {noticeMessage && (
        <div className="attachment-notice-popover" role="alert">
          <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
          <span>{noticeMessage}</span>
        </div>
      )}

      {previewOpen && (
        <DocumentPreviewModal
          isOpen={previewOpen}
          onClose={() => setPreviewOpen(false)}
          attachment={attachment}
        />
      )}
    </div>
  );
}
