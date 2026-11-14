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
  File,
  Globe,
  RefreshCw
} from 'lucide-react';
import {
  getAttachmentRecord,
  downloadAttachmentFile,
  isFormatPreviewable,
  fetchWithAuth,
  isAttachmentOwnedByCurrentUser
} from '../../services/attachmentStorageService.js';
import { extractBrowserDocument } from '../../services/browserDocumentExtractor.js';
import {
  SUPPORTED_OCR_LANGUAGES,
  isLanguagePackCached,
  downloadLanguagePack,
  getLanguageDetails
} from '../../services/ocrLanguagePackService.js';

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

  // Multilingual OCR Language Pack State
  const initialLang = attachment?.extraction?.language || 'eng';
  const [selectedOcrLang, setSelectedOcrLang] = useState(initialLang);
  const [cachedLangs, setCachedLangs] = useState(['eng']);
  const [extractionsByLang, setExtractionsByLang] = useState(
    attachment?.extraction ? { [initialLang]: attachment.extraction } : {}
  );
  const [packDownloading, setPackDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ loaded: 0, total: 0, percent: 0 });
  const [downloadError, setDownloadError] = useState(null);
  const downloadAbortCtrlRef = useRef(null);

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

  // Track cached language packs for offline readiness
  useEffect(() => {
    if (!isOpen || !isImage) return;
    let active = true;

    async function checkPacks() {
      const cached = ['eng'];
      for (const lang of SUPPORTED_OCR_LANGUAGES) {
        if (lang.code !== 'eng') {
          try {
            const isCached = await isLanguagePackCached(lang.code);
            if (isCached && active) {
              cached.push(lang.code);
            }
          } catch (_) {}
        }
      }
      if (active) setCachedLangs(cached);
    }

    checkPacks();
    return () => {
      active = false;
      if (downloadAbortCtrlRef.current) {
        try {
          downloadAbortCtrlRef.current.abort();
        } catch (_) {}
        downloadAbortCtrlRef.current = null;
      }
    };
  }, [isOpen, isImage]);

  const currentLangDetails = getLanguageDetails(selectedOcrLang) || {
    code: selectedOcrLang,
    name: selectedOcrLang.toUpperCase(),
    nativeName: selectedOcrLang.toUpperCase(),
    isRtl: ['ara', 'urd'].includes(selectedOcrLang),
    fileSizeEstimate: '~1.5 MB'
  };
  const isCurrentLangCached = selectedOcrLang === 'eng' || cachedLangs.includes(selectedOcrLang);

  const fetchOcrExtraction = async (langCode) => {
    if (!attachment?.id || isUnsubmittedComposerFile) return;

    if (extractionsByLang[langCode]) {
      const cachedResult = extractionsByLang[langCode];
      setOcrData(cachedResult);
      if (cachedResult?.text) {
        setTextContent(cachedResult.text);
      }
      return;
    }

    setOcrLoading(true);
    setDownloadError(null);
    try {
      const effectiveChatId = attachment.chatId || attachment.conversationId || '';
      const params = new URLSearchParams();
      if (effectiveChatId) params.set('chatId', effectiveChatId);
      if (langCode && langCode !== 'eng') params.set('lang', langCode);
      const queryStr = params.toString() ? `?${params.toString()}` : '';

      const res = await fetchWithAuth(`/api/upload/${attachment.id}/extraction${queryStr}`);
      if (res.ok) {
        const d = await res.json();
        setOcrData(d);
        setExtractionsByLang((prev) => ({ ...prev, [langCode]: d }));
        if (d?.text) {
          setTextContent(d.text);
        }
      } else {
        setOcrData({
          status: 'error',
          error: `Extraction failed with HTTP ${res.status}.`
        });
      }
    } catch (err) {
      setOcrData({
        status: 'error',
        error: err.message || 'Failed to extract text from image.'
      });
    } finally {
      setOcrLoading(false);
    }
  };

  const handleSelectOcrLanguage = async (newLang) => {
    if (newLang === selectedOcrLang) return;
    setSelectedOcrLang(newLang);
    setDownloadError(null);

    const isCached = newLang === 'eng' || cachedLangs.includes(newLang);
    if (isCached) {
      await fetchOcrExtraction(newLang);
    }
  };

  const handleDownloadPack = async () => {
    const langCode = selectedOcrLang;
    if (packDownloading || langCode === 'eng') return;

    setPackDownloading(true);
    setDownloadError(null);
    setDownloadProgress({ loaded: 0, total: 0, percent: 0 });

    const ctrl = new AbortController();
    downloadAbortCtrlRef.current = ctrl;

    try {
      await downloadLanguagePack(langCode, {
        signal: ctrl.signal,
        onProgress: (p) => {
          setDownloadProgress(p);
        }
      });

      setCachedLangs((prev) => (prev.includes(langCode) ? prev : [...prev, langCode]));
      setPackDownloading(false);
      await fetchOcrExtraction(langCode);
    } catch (err) {
      setPackDownloading(false);
      if (err?.name === 'AbortError' || ctrl.signal.aborted) {
        setDownloadError('Download was cancelled.');
      } else {
        setDownloadError(err?.message || 'Failed to download language pack.');
      }
    } finally {
      downloadAbortCtrlRef.current = null;
    }
  };

  const handleCancelDownload = () => {
    if (downloadAbortCtrlRef.current) {
      downloadAbortCtrlRef.current.abort();
      downloadAbortCtrlRef.current = null;
    }
    setPackDownloading(false);
  };

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
          const initLang = attachment.extraction?.language || 'eng';
          setSelectedOcrLang(initLang);
          if (attachment.extraction) {
            setOcrData(attachment.extraction);
            setExtractionsByLang({ [initLang]: attachment.extraction });
            if (attachment.extraction.text) {
              setTextContent(attachment.extraction.text);
            }
          } else if (!isUnsubmittedComposerFile) {
            setOcrLoading(true);
            const effectiveChatId = attachment.chatId || attachment.conversationId || '';
            const query = effectiveChatId ? `?chatId=${encodeURIComponent(effectiveChatId)}` : '';
            fetchWithAuth(`/api/upload/${attachment.id}/extraction${query}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (active && d) {
                  setOcrData(d);
                  const returnedLang = d.language || 'eng';
                  setExtractionsByLang((prev) => ({ ...prev, [returnedLang]: d }));
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
            } else if (
              attachment.extraction &&
              ['encrypted', 'corrupted', 'error', 'empty'].includes(attachment.extraction.status)
            ) {
              if (active) {
                setError(
                  attachment.extraction.error ||
                    attachment.extraction.warning ||
                    'Unable to extract text from this Office document.'
                );
              }
            } else {
              try {
                const extracted = await extractBrowserDocument(attachment.file, {
                  id: attachment.id,
                  name: filename,
                  originalName: filename,
                  mimeType: mime,
                  extension: ext
                });
                if (active) {
                  if (extracted?.text) {
                    setTextContent(extracted.text);
                  } else if (
                    extracted &&
                    ['encrypted', 'corrupted', 'error', 'empty'].includes(extracted.status)
                  ) {
                    setError(
                      extracted.error ||
                        extracted.warning ||
                        'Unable to extract text from this Office document.'
                    );
                  }
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
        if (localRecord?.blob && isAttachmentOwnedByCurrentUser(attachment, localRecord)) {
          if (!active) return;
          const url = URL.createObjectURL(localRecord.blob);
          registerCreatedUrl(url);

          if (isTextual) {
            try {
              const text = await localRecord.blob.text();
              if (active) setTextContent(text);
            } catch (_) {}
          } else if (isOffice) {
            if (attachment.extraction?.text) {
              setTextContent(attachment.extraction.text);
            } else if (
              attachment.extraction &&
              ['encrypted', 'corrupted', 'error', 'empty'].includes(attachment.extraction.status)
            ) {
              setError(
                attachment.extraction.error ||
                  attachment.extraction.warning ||
                  'Unable to extract text from this Office document.'
              );
            } else {
              try {
                const extracted = await extractBrowserDocument(localRecord.blob, {
                  id: attachment.id,
                  name: filename,
                  originalName: filename,
                  mimeType: mime,
                  extension: ext
                });
                if (active) {
                  if (extracted?.text) {
                    setTextContent(extracted.text);
                  } else if (
                    extracted &&
                    ['encrypted', 'corrupted', 'error', 'empty'].includes(extracted.status)
                  ) {
                    setError(
                      extracted.error ||
                        extracted.warning ||
                        'Unable to extract text from this Office document.'
                    );
                  }
                }
              } catch (_) {}
            }
          }
          if (active) setLoading(false);
          return;
        }

        // 2. Fetch from backend server with authentication
        const effectiveFileChatId = attachment.chatId || attachment.conversationId || '';
        const fileQuery = effectiveFileChatId ? `?chatId=${encodeURIComponent(effectiveFileChatId)}` : '';
        const fileRes = await fetchWithAuth(`/api/upload/${attachment.id}/file${fileQuery}`);
        if (!fileRes.ok) {
          if (attachment.extraction?.text) {
            // If binary file is expired but extraction is available in metadata
            if (active) {
              setTextContent(attachment.extraction.text);
              setLoading(false);
            }
            return;
          }
          let customMsg = 'This attachment is no longer available on the server.';
          if (fileRes.status === 401) {
            customMsg = 'Authentication required to preview this attachment. Please sign in.';
          } else if (fileRes.status === 403) {
            customMsg = 'You do not have permission to preview this attachment.';
          }
          throw new Error(customMsg);
        }

        const blob = await fileRes.blob();
        if (!active) return;
        const url = URL.createObjectURL(blob);
        registerCreatedUrl(url);

        if (isTextual) {
          const text = await blob.text();
          if (active) setTextContent(text);
        } else if (isOffice) {
          if (attachment.extraction?.text) {
            setTextContent(attachment.extraction.text);
          } else if (
            attachment.extraction &&
            ['encrypted', 'corrupted', 'error', 'empty'].includes(attachment.extraction.status)
          ) {
            setError(
              attachment.extraction.error ||
                attachment.extraction.warning ||
                'Unable to extract text from this Office document.'
            );
          } else {
            try {
              const extracted = await extractBrowserDocument(blob, {
                id: attachment.id,
                name: filename,
                originalName: filename,
                mimeType: mime,
                extension: ext
              });
              if (active) {
                if (extracted?.text) {
                  setTextContent(extracted.text);
                } else if (
                  extracted &&
                  ['encrypted', 'corrupted', 'error', 'empty'].includes(extracted.status)
                ) {
                  setError(
                    extracted.error ||
                      extracted.warning ||
                      'Unable to extract text from this Office document.'
                  );
                }
              }
            } catch (_) {}
          }
        }

        if (active) setLoading(false);
      } catch (err) {
        if (!active) return;
        if (attachment.extraction?.text) {
          setTextContent(attachment.extraction.text);
          setLoading(false);
        } else if (
          attachment.extraction &&
          ['encrypted', 'corrupted', 'error', 'empty'].includes(attachment.extraction.status)
        ) {
          setError(
            attachment.extraction.error ||
              attachment.extraction.warning ||
              'Unable to preview attachment.'
          );
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
  const sheetsCount = attachment.sheetCount || attachment.extraction?.sheetCount;
  const metaDetail = pagesCount
    ? `${pagesCount} page${pagesCount > 1 ? 's' : ''}`
    : slidesCount
      ? `${slidesCount} slide${slidesCount > 1 ? 's' : ''}`
      : sheetsCount
        ? `${sheetsCount} sheet${sheetsCount > 1 ? 's' : ''}`
        : null;
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
            <div className="preview-ocr-container flex flex-col gap-3 w-full h-full">
              {/* Multilingual OCR Language Selection Toolbar */}
              <div className="preview-ocr-toolbar">
                <div className="preview-ocr-lang-group">
                  <span className="preview-ocr-lang-label">
                    <Globe size={14} className="text-blue-400" />
                    <span>OCR Language:</span>
                  </span>
                  <select
                    className="preview-ocr-lang-select"
                    value={selectedOcrLang}
                    onChange={(e) => handleSelectOcrLanguage(e.target.value)}
                    aria-label="Select OCR language"
                    disabled={packDownloading || ocrLoading}
                  >
                    {SUPPORTED_OCR_LANGUAGES.map((lang) => {
                      const isCached = lang.code === 'eng' || cachedLangs.includes(lang.code);
                      return (
                        <option key={lang.code} value={lang.code}>
                          {lang.name} ({lang.nativeName}) {isCached ? '• Offline Ready' : `• (${lang.fileSizeEstimate})`}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  {isCurrentLangCached ? (
                    <span className="preview-ocr-lang-badge">
                      <Check size={11} className="text-emerald-400" />
                      <span>{currentLangDetails.name} Ready</span>
                    </span>
                  ) : (
                    <span className="preview-ocr-lang-badge text-amber-300">
                      <span>Download needed ({currentLangDetails.fileSizeEstimate})</span>
                    </span>
                  )}
                  {currentLangDetails.isRtl && (
                    <span className="preview-ocr-rtl-badge">RTL</span>
                  )}
                </div>
              </div>

              {/* Body: Download Card OR Loading OR Empty OR Extracted Text OR Error */}
              {!isCurrentLangCached && selectedOcrLang !== 'eng' ? (
                <div className="preview-ocr-pack-card">
                  <div className="preview-ocr-pack-icon">
                    <Globe size={24} />
                  </div>
                  <h3 className="preview-ocr-pack-title">
                    {currentLangDetails.name} ({currentLangDetails.nativeName}) Language Pack Required
                  </h3>
                  <p className="preview-ocr-pack-desc">
                    Download the {currentLangDetails.name} language pack ({currentLangDetails.fileSizeEstimate}) to extract text in {currentLangDetails.name}.
                    Once downloaded, it will be cached locally in your browser for offline recognition.
                  </p>

                  {packDownloading ? (
                    <div className="preview-ocr-progress-wrap">
                      <div className="preview-ocr-progress-bar">
                        <div
                          className="preview-ocr-progress-fill"
                          style={{ width: `${Math.max(5, downloadProgress.percent || 0)}%` }}
                        />
                      </div>
                      <div className="preview-ocr-progress-meta">
                        <span>{downloadProgress.percent || 0}% downloaded</span>
                        <span>
                          {downloadProgress.loaded
                            ? `${(downloadProgress.loaded / (1024 * 1024)).toFixed(1)} MB`
                            : '0 MB'}{' '}
                          / {currentLangDetails.fileSizeEstimate}
                        </span>
                      </div>
                      <div className="preview-ocr-pack-actions">
                        <button
                          type="button"
                          onClick={handleCancelDownload}
                          className="preview-download-btn"
                        >
                          <X size={13} />
                          <span>Cancel Download</span>
                        </button>
                      </div>
                    </div>
                  ) : downloadError ? (
                    <div className="flex flex-col items-center gap-3">
                      <div className="text-xs text-amber-400 bg-amber-950/40 border border-amber-800/50 rounded px-3 py-2">
                        <AlertTriangle size={14} className="inline mr-1 text-amber-400" />
                        {downloadError}
                      </div>
                      <div className="preview-ocr-pack-actions">
                        <button
                          type="button"
                          onClick={handleDownloadPack}
                          className="preview-download-btn"
                        >
                          <RefreshCw size={13} />
                          <span>Retry Download</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSelectOcrLanguage('eng')}
                          className="preview-copy-btn"
                        >
                          <span>Use English OCR</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="preview-ocr-pack-actions">
                      <button
                        type="button"
                        onClick={handleDownloadPack}
                        className="preview-download-btn"
                      >
                        <Download size={13} />
                        <span>Download {currentLangDetails.name} Pack</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSelectOcrLanguage('eng')}
                        className="preview-copy-btn"
                      >
                        <span>Use English OCR</span>
                      </button>
                    </div>
                  )}
                </div>
              ) : ocrLoading ? (
                <div className="preview-status-state">
                  <Loader2 size={28} className="animate-spin text-blue-400" />
                  <span className="preview-status-text">
                    Extracting text in {currentLangDetails.name} with OCR...
                  </span>
                </div>
              ) : ocrData?.status === 'NO_TEXT_DETECTED' || (ocrData?.success && !ocrData?.hasText) ? (
                <div className="preview-status-state">
                  <div className="preview-status-icon-circle info">
                    <FileText size={22} />
                  </div>
                  <h3 className="preview-status-title">No readable text detected in this image</h3>
                  <p className="preview-status-desc">
                    The OCR scan completed successfully, but no readable text was detected for {currentLangDetails.name}.
                  </p>
                </div>
              ) : ocrData?.status === 'ready' && ocrData?.hasText ? (
                <div className="preview-text-container">
                  <div className="preview-ocr-stats-bar">
                    <div className="preview-ocr-stats-group">
                      <span className="preview-ocr-badge">OCR Text Extracted</span>
                      <span className="preview-ocr-lang-badge">{currentLangDetails.name}</span>
                      {currentLangDetails.isRtl && (
                        <span className="preview-ocr-rtl-badge">RTL</span>
                      )}
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
                  <pre
                    className={`preview-text-content ${currentLangDetails.isRtl ? 'preview-text-rtl' : ''}`}
                    dir={currentLangDetails.isRtl ? 'rtl' : 'ltr'}
                  >
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
              )}
            </div>
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
