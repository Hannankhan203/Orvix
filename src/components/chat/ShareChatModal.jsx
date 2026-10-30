import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Copy,
  Check,
  Share2,
  MessageCircle,
  Link2,
  ShieldCheck,
} from 'lucide-react';
import {
  copyShareUrlToClipboard,
  buildWhatsAppShareUrl,
  canUseNativeShare,
  triggerNativeShare,
} from '../../services/shareChatService.js';

/**
 * Accessible modal dialog presenting a newly generated immutable Share Chat link.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {Object|null} props.shareData - `{ shareId, shareUrl, title, mode, messageCount }`
 */
export default function ShareChatModal({ isOpen, onClose, shareData }) {
  const [copied, setCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [nativeShareSupported, setNativeShareSupported] = useState(false);
  const inputRef = useRef(null);
  const copyTimerRef = useRef(null);

  const shareUrl = shareData?.shareUrl || '';
  const title = shareData?.title || 'Shared Chat';
  const messageCount = shareData?.messageCount || 0;

  useEffect(() => {
    setNativeShareSupported(canUseNativeShare());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      setStatusMessage('');
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      return;
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  if (!isOpen || !shareData || !shareUrl) {
    return null;
  }

  const whatsAppUrl = buildWhatsAppShareUrl(shareUrl, title);

  const handleCopyLink = async () => {
    const ok = await copyShareUrlToClipboard(shareUrl);
    if (ok) {
      setCopied(true);
      setStatusMessage('Share link copied to clipboard.');
      if (inputRef.current) {
        inputRef.current.select();
      }
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
      }, 2500);
    } else {
      setStatusMessage('Could not copy automatically. Please select and copy the link above.');
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }
  };

  const handleNativeShare = async () => {
    if (!nativeShareSupported) {
      await handleCopyLink();
      return;
    }
    try {
      const result = await triggerNativeShare({ shareUrl, title });
      if (result.shared) {
        setStatusMessage('Shared successfully.');
      }
    } catch {
      // Fallback to copying link if native share fails
      await handleCopyLink();
    }
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose?.();
    }
  };

  return (
    <div
      className="share-chat-modal-backdrop"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        className="share-chat-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-chat-modal-title"
        aria-describedby="share-chat-modal-desc"
      >
        <div className="share-chat-modal-header">
          <div className="share-chat-modal-title-group">
            <span className="share-chat-modal-icon-badge" aria-hidden="true">
              <Share2 size={16} />
            </span>
            <div>
              <h2 id="share-chat-modal-title" className="share-chat-modal-title">
                Share Conversation
              </h2>
              <p id="share-chat-modal-desc" className="share-chat-modal-subtitle">
                Anyone with this link can view this {messageCount}-message snapshot
              </p>
            </div>
          </div>

          <button
            type="button"
            className="share-chat-modal-close-btn"
            onClick={onClose}
            aria-label="Close share dialog"
            title="Close (Esc)"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="share-chat-modal-body">
          <div className="share-chat-snapshot-meta">
            <span className="share-chat-snapshot-title" title={title}>
              {title}
            </span>
            <span className="share-chat-snapshot-count">
              {messageCount} {messageCount === 1 ? 'message' : 'messages'}
            </span>
          </div>

          <div className="share-chat-url-box">
            <Link2 size={15} className="share-chat-url-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              readOnly
              value={shareUrl}
              onClick={(e) => e.currentTarget.select()}
              className="share-chat-url-input"
              aria-label="Shareable conversation URL"
            />
            <button
              type="button"
              onClick={handleCopyLink}
              className={`share-chat-inline-copy-btn ${copied ? 'copied' : ''}`}
              aria-label={copied ? 'Link copied to clipboard' : 'Copy share link'}
            >
              {copied ? (
                <>
                  <Check size={14} aria-hidden="true" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy size={14} aria-hidden="true" />
                  <span>Copy Link</span>
                </>
              )}
            </button>
          </div>

          <div className="share-chat-actions-grid">
            <button
              type="button"
              onClick={handleCopyLink}
              className={`share-chat-option-btn primary ${copied ? 'copied' : ''}`}
            >
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              <span>{copied ? 'Link Copied' : 'Copy Link'}</span>
            </button>

            <a
              href={whatsAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="share-chat-option-btn whatsapp"
              aria-label="Share conversation link on WhatsApp"
            >
              <MessageCircle size={16} aria-hidden="true" />
              <span>WhatsApp</span>
            </a>

            {nativeShareSupported && (
              <button
                type="button"
                onClick={handleNativeShare}
                className="share-chat-option-btn native-share"
                aria-label="Share using device share sheet"
              >
                <Share2 size={16} aria-hidden="true" />
                <span>Share</span>
              </button>
            )}
          </div>

          {statusMessage && (
            <div className="share-chat-status-feedback" role="status" aria-live="polite">
              {statusMessage}
            </div>
          )}

          <div className="share-chat-privacy-note">
            <ShieldCheck size={14} className="share-chat-privacy-icon" aria-hidden="true" />
            <span>
              Creates a read-only snapshot of the current messages. Your account details and future messages in this chat remain private.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
