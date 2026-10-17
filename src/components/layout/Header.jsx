import React, { useState, useRef, useEffect } from 'react';
import { Menu, Plus, Sparkles, LogOut, User, X, ChevronDown, Check, Edit2, AlertCircle } from 'lucide-react';
import Button from '../ui/Button.jsx';
import ModelSelector from '../chat/ModelSelector.jsx';
import { APP_CONFIG } from '../../config/appConfig.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { validateUsername } from '../../services/userProfileService.js';

/**
 * Header Component
 * Provides responsive navigation for both desktop and mobile screens:
 * - Desktop: Clean single-row toolbar with active breadcrumb, model selector, New Chat, and user profile block.
 * - Mobile: Purpose-built 2-tier header preventing overflow:
 *     Tier 1: Hamburger toggle, brand mark, compact New Chat, and user avatar button.
 *     Tier 2: Compact AI model selector pill and active thread context.
 * - Accessible account popover menu revealing username above email address,
 *   inline username editing/adding, and Sign Out action.
 *
 * @param {Object} props
 * @param {boolean} props.sidebarOpen
 * @param {() => void} props.onToggleSidebar
 * @param {() => void} props.onNewChat
 * @param {string|null} [props.activeTitle=null]
 * @param {string} [props.selectedProvider='gemini']
 * @param {(provider: string) => void} [props.onSelectProvider]
 */
export default function Header({
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  activeTitle = null,
  selectedProvider = 'gemini',
  onSelectProvider
}) {
  const { currentUser, username, updateUsername, logout, actionLoading } = useAuth();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef(null);

  // Username editing state in account popover
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [editUsernameInput, setEditUsernameInput] = useState('');
  const [editError, setEditError] = useState('');
  const [isSavingUsername, setIsSavingUsername] = useState(false);

  // Close account menu on outside click
  useEffect(() => {
    if (!accountMenuOpen) {
      setIsEditingUsername(false);
      setEditError('');
      return;
    }

    const handleClickOutside = (e) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target)) {
        setAccountMenuOpen(false);
        setIsEditingUsername(false);
        setEditError('');
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setAccountMenuOpen(false);
        setIsEditingUsername(false);
        setEditError('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountMenuOpen]);

  const handleLogout = async () => {
    try {
      setAccountMenuOpen(false);
      await logout();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleStartEdit = () => {
    setIsEditingUsername(true);
    setEditUsernameInput(username || '');
    setEditError('');
  };

  const handleSaveUsername = async (e) => {
    e.preventDefault();
    setEditError('');

    const validation = validateUsername(editUsernameInput);
    if (!validation.isValid) {
      setEditError(validation.error);
      return;
    }

    setIsSavingUsername(true);
    try {
      await updateUsername(validation.sanitized);
      setIsEditingUsername(false);
    } catch (err) {
      setEditError(err?.message || 'Failed to update username.');
    } finally {
      setIsSavingUsername(false);
    }
  };

  const userInitial = username
    ? username.trim().charAt(0).toUpperCase()
    : currentUser?.email
    ? currentUser.email.charAt(0).toUpperCase()
    : 'U';

  const userDisplayName = username
    ? username
    : currentUser?.isAnonymous
    ? 'Guest Explorer'
    : currentUser?.email || 'Logged in user';

  const userDisplayEmail = currentUser?.email || (currentUser?.isAnonymous ? 'guest@orvix.ai' : '');

  return (
    <header className="chatora-header-wrapper" ref={accountMenuRef}>
      {/* ====================================================================
          Desktop Header Layout (Visible on width >= 768px)
          ==================================================================== */}
      <div className="header-desktop-view">
        <div className="header-left">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            ariaLabel={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            icon={<Menu size={18} />}
          />

          <div className="header-brand-badge">
            <Sparkles size={14} className="header-badge-icon" />
            <span className="header-brand-name">{APP_CONFIG.name}</span>
          </div>

          {activeTitle && (
            <div className="header-active-thread">
              <span className="header-separator">/</span>
              <span className="header-thread-title" title={activeTitle}>
                {activeTitle}
              </span>
            </div>
          )}
        </div>

        <div className="header-right">
          {/* AI Provider Selector */}
          {onSelectProvider && (
            <ModelSelector
              selectedProvider={selectedProvider}
              onSelectProvider={onSelectProvider}
              className="header-model-selector"
              id="ai-model-select-desktop"
            />
          )}

          {/* New Chat Primary Trigger */}
          <Button
            variant="secondary"
            size="sm"
            onClick={onNewChat}
            icon={<Plus size={15} />}
            title="Start a new chat"
          >
            New Chat
          </Button>

          {/* User Account Controls */}
          {currentUser && (
            <div className="header-user-block">
              <button
                type="button"
                className="desktop-user-trigger"
                onClick={() => setAccountMenuOpen((prev) => !prev)}
                title={`Account: ${userDisplayName}`}
                aria-expanded={accountMenuOpen}
                aria-haspopup="dialog"
              >
                <span className="user-avatar-badge" aria-hidden="true">
                  {currentUser.isAnonymous && !username ? <User size={13} /> : userInitial}
                </span>
                <span className="header-user-email" title={userDisplayName}>
                  {userDisplayName}
                </span>
                <ChevronDown size={12} className="desktop-user-chevron" />
              </button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                disabled={actionLoading}
                icon={<LogOut size={14} />}
                title="Sign out of Orvix"
                ariaLabel="Sign out of Orvix"
              >
                Sign out
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ====================================================================
          Mobile Header Layout (Visible on width < 768px)
          Purpose-built 2-tier design:
          Tier 1: Sidebar Toggle, Brand, New Chat, User Menu
          Tier 2: Compact AI Provider Selector + Active Context
          ==================================================================== */}
      <div className="header-mobile-view">
        {/* Tier 1: Main Action Bar */}
        <div className="header-mobile-top">
          <div className="mobile-top-left">
            <button
              type="button"
              className="mobile-header-btn mobile-menu-btn"
              onClick={onToggleSidebar}
              title={sidebarOpen ? 'Close sidebar' : 'Open chat history'}
              aria-label={sidebarOpen ? 'Close sidebar' : 'Open chat history'}
            >
              <Menu size={20} />
            </button>

            <div className="mobile-brand-badge">
              <Sparkles size={14} className="header-badge-icon" />
              <span className="mobile-brand-title">{APP_CONFIG.name}</span>
            </div>
          </div>

          <div className="mobile-top-right">
            {/* Mobile New Chat Action */}
            <button
              type="button"
              className="mobile-new-chat-btn"
              onClick={onNewChat}
              title="Start a fresh conversation"
              aria-label="Start a new chat"
            >
              <Plus size={15} />
              <span>New</span>
            </button>

            {/* Mobile User Profile Avatar Trigger */}
            {currentUser && (
              <button
                type="button"
                className={`mobile-avatar-btn ${accountMenuOpen ? 'active' : ''}`}
                onClick={() => setAccountMenuOpen((prev) => !prev)}
                title={`Account: ${userDisplayName}`}
                aria-label={`Open account menu for ${userDisplayName}`}
                aria-expanded={accountMenuOpen}
                aria-haspopup="dialog"
              >
                <span className="mobile-avatar-circle">
                  {currentUser.isAnonymous && !username ? <User size={14} /> : userInitial}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Tier 2: Context Bar (AI Model Selector + Chat Title / Status) */}
        <div className="header-mobile-sub">
          <div className="mobile-sub-left">
            {onSelectProvider && (
              <ModelSelector
                selectedProvider={selectedProvider}
                onSelectProvider={onSelectProvider}
                compact
                className="mobile-model-selector"
                id="ai-model-select-mobile"
              />
            )}
          </div>

          <div className="mobile-sub-right">
            {activeTitle ? (
              <div className="mobile-thread-context" title={activeTitle}>
                <span className="mobile-thread-name">{activeTitle}</span>
              </div>
            ) : (
              <div className="mobile-status-pill">
                <span className="mobile-status-dot" aria-hidden="true" />
                <span className="mobile-status-text">Ready</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ====================================================================
          Universal Account Popover Menu (Mobile & Desktop)
          Shows Username prominently above Email address.
          Includes inline username editor and accessible Sign Out.
          ==================================================================== */}
      {accountMenuOpen && currentUser && (
        <div
          className="account-popover-card"
          role="dialog"
          aria-label="User Account Menu"
        >
          <div className="account-popover-header">
            <div className="account-avatar-large">
              {currentUser.isAnonymous && !username ? <User size={20} /> : userInitial}
            </div>

            <div className="account-info-block">
              <span className="account-type-badge">
                {currentUser.isAnonymous ? 'Guest Demo Session' : 'Active Account'}
              </span>

              {/* Username prominently above Email address */}
              <div className="account-username-display-wrap">
                {username ? (
                  <strong className="account-full-username" title={username}>
                    {username}
                  </strong>
                ) : (
                  <span className="account-no-username">No username set</span>
                )}

                {!isEditingUsername && (
                  <button
                    type="button"
                    className="account-username-edit-trigger"
                    onClick={handleStartEdit}
                    title={username ? 'Edit username' : 'Add username'}
                    aria-label={username ? 'Edit username' : 'Add username'}
                  >
                    <Edit2 size={12} />
                    <span>{username ? 'Edit' : 'Add username'}</span>
                  </button>
                )}
              </div>

              {/* Email address displayed underneath username */}
              <span className="account-full-email" title={userDisplayEmail}>
                {userDisplayEmail}
              </span>
            </div>

            <button
              type="button"
              className="account-popover-close"
              onClick={() => {
                setAccountMenuOpen(false);
                setIsEditingUsername(false);
              }}
              title="Close account menu"
              aria-label="Close account menu"
            >
              <X size={15} />
            </button>
          </div>

          {/* Inline Username Editing Form */}
          {isEditingUsername && (
            <form onSubmit={handleSaveUsername} className="account-inline-edit-form">
              <div className="account-inline-input-row">
                <input
                  type="text"
                  className="account-inline-input"
                  value={editUsernameInput}
                  onChange={(e) => setEditUsernameInput(e.target.value)}
                  placeholder="Enter username (2-30 chars)"
                  maxLength={30}
                  disabled={isSavingUsername}
                  autoFocus
                />
                <button
                  type="submit"
                  className="account-inline-save-btn"
                  disabled={isSavingUsername}
                  title="Save username"
                >
                  {isSavingUsername ? <span className="auth-spinner mini" /> : <Check size={14} />}
                  <span>Save</span>
                </button>
                <button
                  type="button"
                  className="account-inline-cancel-btn"
                  onClick={() => {
                    setIsEditingUsername(false);
                    setEditError('');
                  }}
                  disabled={isSavingUsername}
                  title="Cancel editing"
                >
                  <X size={14} />
                </button>
              </div>
              {editError && (
                <div className="account-inline-error">
                  <AlertCircle size={12} />
                  <span>{editError}</span>
                </div>
              )}
            </form>
          )}

          <div className="account-popover-divider" />

          <div className="account-popover-actions">
            <button
              type="button"
              className="account-signout-btn"
              onClick={handleLogout}
              disabled={actionLoading}
            >
              <LogOut size={16} />
              <span>{actionLoading ? 'Signing out...' : 'Sign out of Orvix'}</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
