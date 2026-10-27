import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Download,
  Copy,
  Check,
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  ExternalLink,
  AlertTriangle,
  Loader2,
  File
} from 'lucide-react';
import {
  getAttachmentRecord,
  downloadAttachmentFile,
  isFormatPreviewable
} from '../../services/attachmentStorageService.js';
import { extractBrowserDocument } from '../../services/browserDocumentExtractor.js';

function getModalFormatIcon(ext = '') {
  const cleanExt = (ext || '').replace('.', '').toLowerCase();
  switch (cleanExt) {
    case 'pdf':
      return FileText;
    case 'doc':
    case 'docx':
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
    case 'gif':
    case 'bmp':
    case 'heic':
    case 'heif':
    case 'svg':
      return FileImage;
    default:
      return File;
  }
}

function getModalFormatBadgeClass(ext = '') {
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
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'html':
    case 'css':
      return 'format-text';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
    case 'bmp':
    case 'heic':
    case 'heif':
    case 'svg':
      return 'format-image';
    default:
      return 'format-default';
  }
}

export default function DocumentPreviewModal({ isOpen, onClose, attachment }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [textContent, setTextContent] = useState('');
  const [blobUrl, setBlobUrl] = useState(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [activeView, setActiveView] = useState('image'); // 'image' | 'ocr'
  const [ocrData, setOcrData] = useState(attachment?.extraction || null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const createdObjectUrlRef = useRef(null);

  const filename = attachment?.name || attachment?.originalName || attachment?.filename || 'Document';
  const filenameExt = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : '';
  const ext = (filenameExt || attachment?.extension || attachment?.format || '').replace('.', '').toLowerCase();
  const mime = attachment?.type || attachment?.mimeType || '';
  const IconComponent = getModalFormatIcon(ext);
  const formatBadgeClass = getModalFormatBadgeClass(ext);

  const isPdf = ext === 'pdf' || mime === 'application/pdf';
  const isImage =
    ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp', 'heic', 'heif'].includes(ext) ||
    mime.startsWith('image/');
  const isTextual =
    ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'js', 'jsx', 'ts', 'tsx', 'html', 'css'].includes(ext) ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml';
  const isOffice = ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls'].includes(ext);
  const isUnsubmittedComposerFile =
    attachment?.file instanceof Blob && String(attachment?.id || '').startsWith('att-') && !attachment?.extraction;

  useEffect(() => {
    if (!isOpen || !attachment?.id) return;

    let active = true;
    setLoading(true);
    setError(null);
    setTextContent('');
    setBlobUrl(null);
    setCopied(false);
    setActiveView('image');
    setOcrData(attachment?.extraction || null);

    const registerCreatedUrl = (url) => {
      if (createdObjectUrlRef.current && createdObjectUrlRef.current !== url) {
        try {
          URL.revokeObjectURL(createdObjectUrlRef.current);
        } catch (_) {}
      }
      createdObjectUrlRef.current = url;
      setBlobUrl(url);
    };

    async function loadContent() {
      try {
        // Fetch OCR extraction if not already present on image (skip for unsubmitted local composer attachments)
        if (isImage) {
          if (attachment.extraction) {
            setOcrData(attachment.extraction);
            if (attachment.extraction.text) {
              setTextContent(attachment.extraction.text);
            }
          } else if (!isUnsubmittedComposerFile) {
            setOcrLoading(true);
            fetch(`/api/upload/${attachment.id}/extraction`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (active && d) {
                  setOcrData(d);
                  if (d.text) setTextContent(d.text);
                }
              })
              .catch(() => {})
              .finally(() => {
                if (active) setOcrLoading(false);
              });
          }
        }

        // 0. Direct in-memory File or Blob
        if (attachment.file instanceof Blob) {
          if (!active) return;
          const url = URL.createObjectURL(attachment.file);
          registerCreatedUrl(url);
          if (isTextual) {
            try {
              const text = await attachment.file.text();
              if (active) setTextContent(text);
            } catch (_) {}
          } else if (isOffice) {
            if (attachment.extraction?.text) {
              if (active) setTextContent(attachment.extraction.text);
            } else {
              try {
                const extracted = await extractBrowserDocument(attachment.file, {
                  id: attachment.id,
                  name: filename,
                  originalName: filename,
                  mimeType: mime,
                  extension: ext
                });
                if (active && extracted?.text) {
                  setTextContent(extracted.text);
                }
              } catch (_) {}
            }
          }
          if (active) setLoading(false);
          return;
        }

        // Direct previewUrl or dataUrl (data: or blob: owned externally — do NOT revoke on modal close)
        const directDataUri = attachment.previewUrl || attachment.dataUrl;
        if (typeof directDataUri === 'string' && (directDataUri.startsWith('data:') || directDataUri.startsWith('blob:'))) {
          if (!active) return;
          setBlobUrl(directDataUri);
          if (active) setLoading(false);
          return;
        }

        // 1. Try local IndexedDB
        const localRecord = await getAttachmentRecord(attachment.id);
        if (localRecord?.blob) {
          if (!active) return;
          const url = URL.createObjectURL(localRecord.blob);
          registerCreatedUrl(url);

          if (isTextual) {
            try {
              const text = await localRecord.blob.text();
              if (active) setTextContent(text);
            } catch (_) {}
          } else if (isOffice && attachment.extraction?.text) {
            setTextContent(attachment.extraction.text);
          }
          if (active) setLoading(false);
          return;
        }

        // 2. Fetch from backend server
        const fileRes = await fetch(`/api/upload/${attachment.id}/file`);
        if (!fileRes.ok) {
          if (attachment.extraction?.text) {
            // If binary file is expired but extraction is available in metadata
            if (active) {
              setTextContent(attachment.extraction.text);
              setLoading(false);
            }
            return;
          }
          throw new Error('This attachment is no longer available on the server.');
        }

        const blob = await fileRes.blob();
        if (!active) return;
        const url = URL.createObjectURL(blob);
        registerCreatedUrl(url);

        if (isTextual) {
          const text = await blob.text();
          if (active) setTextContent(text);
        } else if (isOffice && attachment.extraction?.text) {
          setTextContent(attachment.extraction.text);
        }

        if (active) setLoading(false);
      } catch (err) {
        if (!active) return;
        if (attachment.extraction?.text) {
          setTextContent(attachment.extraction.text);
          setLoading(false);
        } else {
          setError(err.message || 'Unable to preview attachment.');
          setLoading(false);
        }
      }
    }

    loadContent();

    return () => {
      active = false;
      if (createdObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(createdObjectUrlRef.current);
        } catch (_) {}
        createdObjectUrlRef.current = null;
      }
    };
  }, [isOpen, attachment?.id, ext, isTextual, isOffice, isImage, isUnsubmittedComposerFile, filename, mime]);

  // Handle ESC key to close and focus close button on open
  const closeBtnRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const focusTimer = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 50);
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !attachment) return null;

  const handleDownloadOriginal = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadAttachmentFile(attachment);
    } catch (_) {}
    setDownloading(false);
  };

  const handleCopyText = async () => {
    const textToCopy = isImage && activeView === 'ocr' ? (ocrData?.text || textContent) : textContent;
    if (!textToCopy) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (_) {}
  };

  const sizeText = attachment.formattedSize || (attachment.size ? `${(attachment.size / 1024).toFixed(1)} KB` : '');
  const pagesCount = attachment.pageCount || attachment.extraction?.pageCount;
  const slidesCount = attachment.slideCount || attachment.extraction?.slideCount;
  const metaDetail = pagesCount ? `${pagesCount} page${pagesCount > 1 ? 's' : ''}` : slidesCount ? `${slidesCount} slide${slidesCount > 1 ? 's' : ''}` : null;
  const hasCopyableText = Boolean(textContent || (isImage && activeView === 'ocr' && ocrData?.text));

  return (
    <div
      className="document-preview-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
    >
      <div
        className="document-preview-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="preview-modal-header">
          <div className="preview-modal-title-group">
            <div className={`preview-modal-icon-badge ${formatBadgeClass}`} aria-hidden="true">
              <IconComponent size={18} />
            </div>
            <div className="preview-modal-title-wrap">
              <h2
                id="preview-modal-title"
                className="preview-modal-title"
                title={filename}
              >
                {filename}
              </h2>
              <div className="preview-modal-meta">
                <span className="preview-modal-ext-pill">
                  {ext.toUpperCase() || 'FILE'}
                </span>
                {sizeText && <span className="preview-modal-meta-item">• {sizeText}</span>}
                {metaDetail && <span className="preview-modal-meta-item">• {metaDetail}</span>}
              </div>
            </div>
          </div>

          <div className="preview-modal-desktop-controls">
            {isImage && !isUnsubmittedComposerFile && (
              <div className="preview-view-tabs" role="tablist" aria-label="Preview modes">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeView === 'image'}
                  onClick={() => setActiveView('image')}
                  className={`preview-tab-btn ${activeView === 'image' ? 'active' : ''}`}
                  title="View original image"
                >
                  <FileImage size={13} aria-hidden="true" />
                  <span>Image</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeView === 'ocr'}
                  onClick={() => setActiveView('ocr')}
                  className={`preview-tab-btn ${activeView === 'ocr' ? 'active' : ''}`}
                  title="View OCR extracted text"
                >
                  <FileText size={13} aria-hidden="true" />
                  <span>Extracted Text</span>
                  {ocrData?.status === 'ready' && ocrData?.hasText ? (
                    <span className="preview-tab-dot" title="Text detected" />
                  ) : null}
                </button>
              </div>
            )}

            {hasCopyableText && (
              <button
                type="button"
                onClick={handleCopyText}
                className="preview-copy-btn"
                title="Copy extracted text to clipboard"
                aria-label="Copy extracted text"
              >
                {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                <span>{copied ? 'Copied' : 'Copy Text'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleDownloadOriginal}
              disabled={downloading}
              className="preview-download-btn"
              title={`Download original file (${filename})`}
              aria-label={`Download original file ${filename}`}
            >
              {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              <span>Download</span>
            </button>
          </div>

          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className="preview-close-btn"
            aria-label="Close preview"
            title="Close preview (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* Mobile Dedicated Toolbar for Tabs and Actions */}
        <div className="preview-modal-mobile-toolbar">
          {isImage && !isUnsubmittedComposerFile && (
            <div className="preview-view-tabs" role="tablist" aria-label="Preview modes">
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'image'}
                onClick={() => setActiveView('image')}
                className={`preview-tab-btn ${activeView === 'image' ? 'active' : ''}`}
                title="View original image"
              >
                <FileImage size={13} aria-hidden="true" />
                <span>Image</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'ocr'}
                onClick={() => setActiveView('ocr')}
                className={`preview-tab-btn ${activeView === 'ocr' ? 'active' : ''}`}
                title="View OCR extracted text"
              >
                <FileText size={13} aria-hidden="true" />
                <span>Extracted Text</span>
                {ocrData?.status === 'ready' && ocrData?.hasText ? (
                  <span className="preview-tab-dot" title="Text detected" />
                ) : null}
              </button>
            </div>
          )}

          <div className="preview-modal-mobile-actions">
            {hasCopyableText && (
              <button
                type="button"
                onClick={handleCopyText}
                className="preview-copy-btn"
                title="Copy extracted text to clipboard"
                aria-label="Copy extracted text"
              >
                {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleDownloadOriginal}
              disabled={downloading}
              className="preview-download-btn"
              title={`Download original file (${filename})`}
              aria-label={`Download original file ${filename}`}
            >
              {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              <span>Download</span>
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="preview-modal-body">
          {loading ? (
            <div className="preview-status-state">
              <Loader2 size={28} className="animate-spin text-blue-400" />
              <span className="preview-status-text">Loading document preview...</span>
            </div>
          ) : error ? (
            <div className="preview-status-state error">
              <AlertTriangle size={32} className="text-amber-400" />
              <p className="preview-status-text">{error}</p>
              <button
                type="button"
                onClick={handleDownloadOriginal}
                className="preview-download-btn mt-2"
              >
                <Download size={14} />
                <span>Try Direct Download</span>
              </button>
            </div>
          ) : isPdf && blobUrl ? (
            <div className="preview-pdf-container">
              <iframe
                src={blobUrl}
                title={filename}
                className="preview-pdf-frame"
              />
            </div>
          ) : isImage && activeView === 'image' && blobUrl ? (
            <div className="preview-image-viewport">
              <img
                src={blobUrl}
                alt={filename}
                className="preview-image-element"
              />
            </div>
          ) : isImage && activeView === 'ocr' ? (
            ocrLoading ? (
              <div className="preview-status-state">
                <Loader2 size={28} className="animate-spin text-blue-400" />
                <span className="preview-status-text">Extracting text from image with OCR...</span>
              </div>
            ) : ocrData?.status === 'NO_TEXT_DETECTED' || (ocrData?.success && !ocrData?.hasText) ? (
              <div className="preview-status-state">
                <div className="preview-status-icon-circle info">
                  <FileText size={22} />
                </div>
                <h3 className="preview-status-title">No readable text detected in this image</h3>
                <p className="preview-status-desc">
                  The OCR scan completed successfully, but no readable text or characters were found in this image.
                </p>
              </div>
            ) : ocrData?.status === 'ready' && ocrData?.hasText ? (
              <div className="preview-text-container">
                <div className="preview-ocr-stats-bar">
                  <div className="preview-ocr-stats-group">
                    <span className="preview-ocr-badge">OCR Text Extracted</span>
                    {ocrData.confidence > 0 && (
                      <span className="preview-ocr-confidence">• Confidence: {ocrData.confidence}%</span>
                    )}
                  </div>
                  <div className="preview-ocr-counts">
                    <span>{ocrData.totalWords || 0} words</span>
                    <span>• {ocrData.totalCharacters || 0} characters</span>
                    {ocrData.lineCount ? <span>• {ocrData.lineCount} lines</span> : null}
                  </div>
                </div>
                <pre className="preview-text-content">
                  {ocrData.text || textContent}
                </pre>
              </div>
            ) : ocrData?.status === 'unsupported_format' ? (
              <div className="preview-status-state">
                <div className="preview-status-icon-circle warning">
                  <AlertTriangle size={22} />
                </div>
                <h3 className="preview-status-title">OCR Format Not Supported</h3>
                <p className="preview-status-desc">
                  {ocrData?.error || 'Text extraction is not supported for this image format in this environment.'}
                </p>
              </div>
            ) : (
              <div className="preview-status-state">
                <div className="preview-status-icon-circle danger">
                  <AlertTriangle size={22} />
                </div>
                <h3 className="preview-status-title">Image Processing Error</h3>
                <p className="preview-status-desc">
                  {ocrData?.error || 'Failed to process image for text extraction.'}
                </p>
              </div>
            )
          ) : isTextual || textContent ? (
            <div className="preview-text-container">
              {isOffice && (
                <div className="preview-office-notice">
                  <span>Displaying extracted text preview. Use Download above for the original formatted Office document.</span>
                </div>
              )}
              <pre className="preview-text-content">
                {textContent || 'No readable text content available.'}
              </pre>
            </div>
          ) : (
            <div className="preview-status-state">
              <div className={`preview-status-icon-circle ${formatBadgeClass}`}>
                <IconComponent size={32} />
              </div>
              <h3 className="preview-status-title">Preview not available for this format</h3>
              <p className="preview-status-desc">
                This file format ({(ext || 'FILE').toUpperCase()}) cannot be natively rendered in the browser. Click below to download the original file.
              </p>
              <button
                type="button"
                onClick={handleDownloadOriginal}
                className="preview-download-btn mt-2"
              >
                <Download size={14} />
                <span>Download {filename}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
