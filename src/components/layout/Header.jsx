import React from 'react';
import { Menu, Plus, Sparkles, LogOut } from 'lucide-react';
import Button from '../ui/Button.jsx';
import ModelSelector from '../chat/ModelSelector.jsx';
import { APP_CONFIG } from '../../config/appConfig.js';
import { useAuth } from '../../context/AuthContext.jsx';

/**
 * Header Component
 * Top navigation bar with sidebar toggle, active thread title, AI model dropdown,
 * new chat trigger, and user profile/logout actions.
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
  const { currentUser, logout, actionLoading } = useAuth();

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  return (
    <header className="chatora-header">
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
          <Sparkles size={13} className="header-badge-icon" />
          <span className="header-brand-name">{APP_CONFIG.name}</span>
        </div>

        {activeTitle && (
          <div className="header-active-thread">
            <span className="header-separator">/</span>
            <span className="header-thread-title" title={activeTitle}>
              {activeTitle}
            </span>
            <span className="header-sample-tag">Demo</span>
          </div>
        )}
      </div>

      <div className="header-right">
        {/* Header AI Provider Selector */}
        {onSelectProvider && (
          <ModelSelector
            selectedProvider={selectedProvider}
            onSelectProvider={onSelectProvider}
            className="header-model-selector"
          />
        )}

        <Button
          variant="secondary"
          size="sm"
          onClick={onNewChat}
          icon={<Plus size={15} />}
          title="Start a new chat"
        >
          New Chat
        </Button>

        {currentUser && (
          <div className="header-user-block">
            <span className="header-user-email" title={currentUser.email || 'Logged in user'}>
              {currentUser.isAnonymous ? 'Guest User' : currentUser.email}
            </span>
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
    </header>
  );
}
