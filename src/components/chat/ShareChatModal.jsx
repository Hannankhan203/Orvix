import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Copy,
  Check,
  Share2,
  MessageCircle,
  Link2,
  ShieldCheck,
  Clock,
  Ban,
  AlertCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  copyShareUrlToClipboard,
  buildWhatsAppShareUrl,
  canUseNativeShare,
  triggerNativeShare,
} from '../../services/shareChatService.js';

const EXPIRATION_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

/** @param {any} expiresAtMs */
function formatExpirationLabel(expiresAtMs) {
  if (!expiresAtMs || !Number.isFinite(expiresAtMs)) {
    return 'Never expires';
  }
  try {
    const formatted = new Date(expiresAtMs).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `Expires ${formatted}`;
  } catch {
    return 'Expires automatically';
  }
}

/**
 * Accessible modal dialog for configuring expiration, generating, sharing,
 * and revoking a conversation share link.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {any} props.shareData - `{ shareId, shareUrl, title, mode, messageCount, expiresAtMs, revoked }`
 * @param {any} [props.chatMeta] - `{ id, title, messageCount }`
 * @param {(expirationPreset: string) => Promise<void>|void} [props.onCreateShare]
 * @param {(shareId: string) => Promise<void>|void} [props.onRevokeShare]
 * @param {boolean} [props.isCreatingShare=false]
 * @param {boolean} [props.isRevokingShare=false]
 * @param {string|null} [props.errorMessage=null]
 * @param {() => void} [props.onResetShare]
 */
export default function ShareChatModal({
  isOpen,
  onClose,
  shareData,
  chatMeta = null,
  onCreateShare,
  onRevokeShare,
  isCreatingShare = false,
  isRevokingShare = false,
  errorMessage = null,
  onResetShare,
}) {
  const [copied, setCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [nativeShareSupported, setNativeShareSupported] = useState(false);
  const [selectedExpiration, setSelectedExpiration] = useState('never');
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const inputRef = useRef(null);
  const copyTimerRef = useRef(null);

  const shareUrl = shareData?.shareUrl || '';
  const isRevoked = Boolean(shareData?.revoked);
  const hasActiveShare = Boolean(shareData && shareUrl && !isRevoked);
  const title = shareData?.title || chatMeta?.title || 'Shared Chat';
  const messageCount = shareData?.messageCount ?? chatMeta?.messageCount ?? 0;

  useEffect(() => {
    setNativeShareSupported(canUseNativeShare());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      setStatusMessage('');
      setConfirmingRevoke(false);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      return;
    }

    const handleKeyDown = (/** @type {any} */ e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (confirmingRevoke && !isRevokingShare) {
          setConfirmingRevoke(false);
          return;
        }
        onClose?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, confirmingRevoke, isRevokingShare]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  if (!isOpen || (!shareData && !chatMeta)) {
    return null;
  }

  const whatsAppUrl = hasActiveShare ? buildWhatsAppShareUrl(shareUrl, title) : '';

  const handleCopyLink = async () => {
    if (!hasActiveShare) return;
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
    if (!hasActiveShare) return;
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
      await handleCopyLink();
    }
  };

  const handleGenerateClick = async () => {
    if (!onCreateShare || isCreatingShare) return;
    setStatusMessage('');
    setConfirmingRevoke(false);
    await onCreateShare(selectedExpiration);
  };

  const handleConfirmRevoke = async () => {
    if (!onRevokeShare || !shareData?.shareId || isRevokingShare) return;
    await onRevokeShare(shareData.shareId);
    setConfirmingRevoke(false);
    setCopied(false);
    setStatusMessage('Share link revoked. Anyone visiting the old link can no longer access it.');
  };

  const handleBackdropClick = (/** @type {any} */ e) => {
    if (e.target === e.currentTarget && !isCreatingShare && !isRevokingShare) {
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
                {isRevoked
                  ? 'This share link has been revoked'
                  : hasActiveShare
                  ? `Anyone with this link can view this ${messageCount}-message snapshot`
                  : `Create a read-only link for this ${messageCount}-message snapshot`}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="share-chat-modal-close-btn"
            onClick={onClose}
            disabled={isCreatingShare || isRevokingShare}
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

          {errorMessage && (
            <div className="share-chat-error-banner" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
          )}

          {isRevoked ? (
            <div className="share-chat-revoked-panel" role="status">
              <div className="share-chat-revoked-badge">
                <Ban size={15} aria-hidden="true" />
                <span>Link Revoked</span>
              </div>
              <p className="share-chat-revoked-desc">
                This shared link has been deactivated. Previous recipients will see a revocation notice if they try to open it.
              </p>
              {onResetShare && (
                <button
                  type="button"
                  className="share-chat-option-btn primary"
                  onClick={() => {
                    setStatusMessage('');
                    onResetShare();
                  }}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                  <span>Create a New Share Link</span>
                </button>
              )}
            </div>
          ) : !hasActiveShare ? (
            <div className="share-chat-create-section">
              <div className="share-chat-expiry-field">
                <label htmlFor="share-expiration-select" className="share-chat-expiry-label">
                  <Clock size={14} aria-hidden="true" />
                  <span>Link expiration</span>
                </label>
                <div
                  className="share-chat-expiry-options"
                  role="radiogroup"
                  aria-label="Share link expiration"
                >
                  {EXPIRATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={selectedExpiration === opt.value}
                      disabled={isCreatingShare}
                      onClick={() => setSelectedExpiration(opt.value)}
                      className={`share-chat-expiry-option ${selectedExpiration === opt.value ? 'active' : ''}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="share-chat-option-btn primary share-chat-create-btn"
                onClick={handleGenerateClick}
                disabled={isCreatingShare}
              >
                {isCreatingShare ? (
                  <>
                    <Loader2 size={16} className="spin-icon" aria-hidden="true" />
                    <span>Generating Link...</span>
                  </>
                ) : (
                  <>
                    <Link2 size={16} aria-hidden="true" />
                    <span>Create Share Link</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            <>
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

              <div className="share-chat-expiry-status">
                <Clock size={13} aria-hidden="true" />
                <span>{formatExpirationLabel(shareData?.expiresAtMs)}</span>
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

              {onRevokeShare && (
                <div className="share-chat-revoke-section">
                  {confirmingRevoke ? (
                    <div className="share-chat-revoke-confirm" role="alertdialog" aria-label="Confirm revoke share link">
                      <span className="share-chat-revoke-confirm-text">
                        Revoke this link? Anyone opening it will lose access immediately.
                      </span>
                      <div className="share-chat-revoke-confirm-actions">
                        <button
                          type="button"
                          className="share-chat-revoke-cancel-btn"
                          onClick={() => setConfirmingRevoke(false)}
                          disabled={isRevokingShare}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="share-chat-revoke-confirm-btn"
                          onClick={handleConfirmRevoke}
                          disabled={isRevokingShare}
                        >
                          {isRevokingShare ? 'Revoking...' : 'Confirm Revoke'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="share-chat-revoke-btn"
                      onClick={() => setConfirmingRevoke(true)}
                      disabled={isRevokingShare}
                    >
                      <Ban size={14} aria-hidden="true" />
                      <span>Revoke Link</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}

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
