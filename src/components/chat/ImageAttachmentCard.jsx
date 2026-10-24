import React, { useState, useEffect } from 'react';
import {
  Eye,
  Download,
  FileImage,
  AlertTriangle,
  Loader2,
  Maximize2
} from 'lucide-react';
import {
  getAttachmentRecord,
  downloadAttachmentFile
} from '../../services/attachmentStorageService.js';
import DocumentPreviewModal from './DocumentPreviewModal.jsx';

/**
 * Formats byte size safely for display
 */
function formatSize(size, formattedSize) {
  if (formattedSize) return formattedSize;
  if (!size || size <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * ImageAttachmentCard Component
 * Renders an uploaded image as a visible, interactive thumbnail inside user messages.
 * Clicking the image opens the full-size view and OCR text via DocumentPreviewModal.
 * If the image format cannot be natively rendered by the browser (e.g. HEIC),
 * it displays an informative fallback with direct open and download options.
 *
 * @param {Object} props
 * @param {Object} props.attachment - Attachment object with metadata (id, name, type, size, extraction, etc.)
 * @param {string} [props.className=''] - Additional CSS classes
 */
export default function ImageAttachmentCard({ attachment, className = '' }) {
  const [imageSrc, setImageSrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState(null);

  if (!attachment) return null;

  const filename = attachment.originalName || attachment.name || attachment.filename || 'Image';
  const ext = (attachment.extension || '').replace('.', '').toUpperCase() || 'IMG';
  const sizeText = formatSize(attachment.size, attachment.formattedSize);
  const isHeic = ext === 'HEIC' || ext === 'HEIF' || (attachment.type || '').includes('heic') || (attachment.type || '').includes('heif');

  // Dismiss transient notice
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  // Resolve image source URL (IndexedDB blob -> file object -> backend file URL)
  useEffect(() => {
    let active = true;
    let createdBlobUrl = null;

    async function resolveSource() {
      setLoading(true);
      setHasError(false);

      // 1. Direct in-memory File or Blob
      if (attachment.file instanceof Blob) {
        createdBlobUrl = URL.createObjectURL(attachment.file);
        if (active) {
          setImageSrc(createdBlobUrl);
          setLoading(false);
        }
        return;
      }

      // 2. Pre-existing previewUrl or dataUrl (e.g. data:image/...)
      const directDataUri = attachment.previewUrl || attachment.dataUrl || attachment.base64;
      if (typeof directDataUri === 'string' && (directDataUri.startsWith('data:') || directDataUri.startsWith('blob:'))) {
        if (active) {
          setImageSrc(directDataUri);
          setLoading(false);
        }
        return;
      }

      // 3. Blob URL or external URL (excluding /api/upload endpoints for now)
      if (typeof attachment.url === 'string' && attachment.url && !attachment.url.startsWith('/api/upload')) {
        if (active) {
          setImageSrc(attachment.url);
          setLoading(false);
        }
        return;
      }

      // 4. Check client-side IndexedDB
      if (attachment.id) {
        try {
          const record = await getAttachmentRecord(attachment.id);
          if (record?.blob && active) {
            createdBlobUrl = URL.createObjectURL(record.blob);
            setImageSrc(createdBlobUrl);
            setLoading(false);
            return;
          }
        } catch (_) {}

        // 5. Fallback to backend serving endpoint
        if (active) {
          setImageSrc(`/api/upload/${attachment.id}/file`);
          setLoading(false);
        }
      } else {
        if (active) {
          setLoading(false);
          setHasError(true);
        }
      }
    }

    resolveSource();

    return () => {
      active = false;
      if (createdBlobUrl) {
        URL.revokeObjectURL(createdBlobUrl);
      }
    };
  }, [attachment.id, attachment.file, attachment.url, attachment.previewUrl, attachment.dataUrl, attachment.base64]);

  const handleCardClick = (e) => {
    if (e.target.closest('.image-card-action-btn')) {
      return;
    }
    setPreviewOpen(true);
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await downloadAttachmentFile(attachment);
      if (!res.success) {
        setNotice(res.error || 'Failed to download image.');
      }
    } catch (_) {
      setNotice('Unable to download image.');
    } finally {
      setDownloading(false);
    }
  };

  const handleImageLoad = () => {
    setLoading(false);
    setHasError(false);
  };

  const handleImageError = () => {
    setLoading(false);
    setHasError(true);
  };

  return (
    <>
      <div className={`message-image-card-wrapper ${className}`}>
        <div
          className={`message-image-card ${hasError ? 'is-error' : ''}`}
          onClick={handleCardClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleCardClick(e);
            }
          }}
          title={`${filename}${sizeText ? ` (${sizeText})` : ''} — Click to view larger`}
          aria-label={`Attached image: ${filename}${sizeText ? `, ${sizeText}` : ''}`}
        >
          {/* Main Visual Thumbnail Area */}
          <div className="message-image-thumbnail-container">
            {loading && (
              <div className="image-loading-placeholder" aria-label="Loading image preview">
                <Loader2 size={20} className="animate-spin text-blue-400" />
              </div>
            )}

            {!hasError && !isHeic && imageSrc ? (
              <img
                src={imageSrc}
                alt={filename}
                className={`message-image-thumbnail ${loading ? 'opacity-0' : 'opacity-100'}`}
                onLoad={handleImageLoad}
                onError={handleImageError}
                loading="lazy"
              />
            ) : (
              /* Fallback for formats not natively rendered in browser (e.g. HEIC) or load error */
              <div className="image-fallback-container">
                <div className="image-fallback-icon-wrap">
                  {isHeic ? (
                    <FileImage size={24} className="text-blue-400" />
                  ) : (
                    <AlertTriangle size={24} className="text-amber-400" />
                  )}
                </div>
                <span className="image-fallback-ext">{ext}</span>
                <span className="image-fallback-msg">
                  {isHeic
                    ? 'HEIC Image (Click to open / view)'
                    : 'Image preview unavailable'}
                </span>
              </div>
            )}

            {/* Hover Overlay with Preview Icon */}
            {!hasError && (
              <div className="message-image-overlay" aria-hidden="true">
                <div className="image-overlay-badge">
                  <Maximize2 size={14} />
                  <span>View Larger</span>
                </div>
              </div>
            )}
          </div>

          {/* Caption & Metadata Footer */}
          <div className="message-image-caption">
            <div className="message-image-info">
              <span className="message-image-name" title={filename}>
                {filename}
              </span>
              <div className="message-image-meta">
                <span className="image-ext-pill">{ext}</span>
                {sizeText && <span className="image-size-text">{sizeText}</span>}
              </div>
            </div>

            {/* Direct Action Buttons */}
            <div className="message-image-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="image-card-action-btn"
                onClick={() => setPreviewOpen(true)}
                title={`Open larger preview of ${filename}`}
                aria-label={`Open larger preview of ${filename}`}
              >
                <Eye size={13} />
              </button>
              <button
                type="button"
                className="image-card-action-btn"
                onClick={handleDownload}
                title={`Download ${filename}`}
                aria-label={`Download ${filename}`}
                disabled={downloading}
              >
                {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              </button>
            </div>
          </div>
        </div>

        {notice && (
          <div className="attachment-notice-popover" role="alert">
            <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
            <span>{notice}</span>
          </div>
        )}
      </div>

      {/* Larger View & OCR Modal */}
      {previewOpen && (
        <DocumentPreviewModal
          isOpen={previewOpen}
          onClose={() => setPreviewOpen(false)}
          attachment={attachment}
        />
      )}
    </>
  );
}
