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

  const filename = attachment?.name || attachment?.originalName || 'Document';
  const filenameExt = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : '';
  const ext = (filenameExt || attachment?.extension || attachment?.format || '').replace('.', '').toLowerCase();
  const mime = attachment?.type || attachment?.mimeType || '';
  const IconComponent = getModalFormatIcon(ext);

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
  const hasCopyableText = Boolean(textContent || (isImage && activeView === 'ocr' && ocrData?.text));

  return (
    <div
      className="document-preview-overlay fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-in fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
    >
      <div
        className="document-preview-modal bg-[#192230] text-[#f8fafc] border border-white/10 rounded-xl shadow-2xl flex flex-col w-full max-w-4xl max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="preview-modal-header">
          <div className="preview-modal-title-group">
            <div className="preview-modal-icon-badge" aria-hidden="true">
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
                  {ext || 'FILE'}
                </span>
                {sizeText && <span>• {sizeText}</span>}
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
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Text detected" />
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
              title="Download original file"
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
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Text detected" />
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
              title="Download original file"
              aria-label={`Download original file ${filename}`}
            >
              {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              <span>Download</span>
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="preview-modal-body flex-1 overflow-auto p-4 min-h-[300px] flex items-center justify-center bg-[#0e131b]">
          {loading ? (
            <div className="flex flex-col items-center gap-3 text-slate-400 py-12">
              <Loader2 size={28} className="animate-spin text-blue-400" />
              <span className="text-sm">Loading document preview...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 text-center p-8 max-w-md">
              <AlertTriangle size={32} className="text-amber-400" />
              <p className="text-sm text-slate-300">{error}</p>
              <button
                type="button"
                onClick={handleDownloadOriginal}
                className="mt-2 inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
              >
                <Download size={14} />
                <span>Try Direct Download</span>
              </button>
            </div>
          ) : isPdf && blobUrl ? (
            <iframe
              src={blobUrl}
              title={filename}
              className="w-full h-[70vh] rounded-md border border-white/5 bg-white"
            />
          ) : isImage && activeView === 'image' && blobUrl ? (
            <div className="flex items-center justify-center max-h-[70vh] p-2">
              <img
                src={blobUrl}
                alt={filename}
                className="max-h-[70vh] max-w-full object-contain rounded-md shadow-md"
              />
            </div>
          ) : isImage && activeView === 'ocr' ? (
            ocrLoading ? (
              <div className="flex flex-col items-center gap-3 text-slate-400 py-12">
                <Loader2 size={28} className="animate-spin text-blue-400" />
                <span className="text-sm">Extracting text from image with OCR...</span>
              </div>
            ) : ocrData?.status === 'NO_TEXT_DETECTED' || (ocrData?.success && !ocrData?.hasText) ? (
              <div className="flex flex-col items-center justify-center p-8 text-center max-w-md my-auto">
                <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-400 mb-3">
                  <FileText size={22} />
                </div>
                <h3 className="text-base font-semibold text-slate-100">No readable text detected in this image.</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  The OCR scan completed successfully, but no readable text or characters were found in this image.
                </p>
              </div>
            ) : ocrData?.status === 'ready' && ocrData?.hasText ? (
              <div className="w-full h-full max-h-[70vh] flex flex-col">
                <div className="preview-ocr-stats-bar text-xs text-slate-300 bg-white/5 border border-white/10 px-3 py-2 rounded-md mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-emerald-400">OCR Text Extracted</span>
                    {ocrData.confidence > 0 && (
                      <span className="text-slate-400">• Confidence: {ocrData.confidence}%</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-slate-400 flex-wrap">
                    <span>{ocrData.totalWords || 0} words</span>
                    <span>{ocrData.totalCharacters || 0} characters</span>
                    {ocrData.lineCount ? <span>{ocrData.lineCount} lines</span> : null}
                  </div>
                </div>
                <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-slate-200 bg-[#0b0f15] border border-white/10 rounded-lg whitespace-pre-wrap word-break leading-relaxed select-text">
                  {ocrData.text || textContent}
                </pre>
              </div>
            ) : ocrData?.status === 'unsupported_format' ? (
              <div className="flex flex-col items-center justify-center p-8 text-center max-w-md my-auto">
                <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-400 mb-3">
                  <AlertTriangle size={22} />
                </div>
                <h3 className="text-base font-semibold text-slate-100">OCR Format Not Supported</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  {ocrData?.error || 'Text extraction is not supported for this image format in this environment.'}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-8 text-center max-w-md my-auto">
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center text-red-400 mb-3">
                  <AlertTriangle size={22} />
                </div>
                <h3 className="text-base font-semibold text-slate-100">Image Processing Error</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  {ocrData?.error || 'Failed to process image for text extraction.'}
                </p>
              </div>
            )
          ) : isTextual || textContent ? (
            <div className="w-full h-full max-h-[70vh] flex flex-col">
              {isOffice && (
                <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3 py-2 rounded-md mb-3 flex items-center justify-between">
                  <span>Displaying extracted text preview. Use Download above for the original formatted Office document.</span>
                </div>
              )}
              <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-slate-200 bg-[#0b0f15] border border-white/10 rounded-lg whitespace-pre-wrap word-break leading-relaxed select-text">
                {textContent || 'No readable text content available.'}
              </pre>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 text-center p-8 max-w-md">
              <IconComponent size={40} className="text-blue-400" />
              <div>
                <p className="text-sm font-medium text-slate-200">Preview not available for this format</p>
                <p className="text-xs text-slate-400 mt-1">
                  This file format ({ext.toUpperCase()}) cannot be natively rendered in the browser. Click below to download the original file.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDownloadOriginal}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
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
