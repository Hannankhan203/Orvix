import React from 'react';

/**
 * SharedConversationBanner Component
 * Displays indicator banner for shared conversation previews (read-only vs interactive continuation).
 */
export default function SharedConversationBanner({
  isSharedView = false,
  sharedSnapshot = null,
  isAuthenticatedSharedPreview = false,
  onSignInClick
}) {
  if (!isSharedView || !sharedSnapshot) return null;

  return (
    <div
      className={`shared-chat-indicator-banner ${isAuthenticatedSharedPreview ? 'is-authenticated-preview' : 'is-public-viewer'}`}
      role="region"
      aria-label="Shared conversation banner"
    >
      <div className="shared-banner-left">
        <div className="shared-banner-badge">
          <span className={`shared-badge-dot ${isAuthenticatedSharedPreview ? 'is-preview-dot' : ''}`} aria-hidden="true" />
          <span className="shared-badge-title">
            {isAuthenticatedSharedPreview ? 'Shared Conversation · Preview' : 'Shared Conversation · Read Only'}
          </span>
        </div>
        <p className="shared-banner-description">
          {isAuthenticatedSharedPreview
            ? 'You are viewing a shared conversation preview. Type and send a message to continue this conversation.'
            : 'You are viewing a published snapshot of this conversation. Messaging and edits are disabled in read-only mode.'}
        </p>
      </div>
      {!isAuthenticatedSharedPreview && onSignInClick && (
        <div className="shared-banner-right">
          <button
            type="button"
            className="shared-banner-signin-btn"
            onClick={onSignInClick}
          >
            Sign In
          </button>
        </div>
      )}
    </div>
  );
}
