import React from 'react';
import { Bot, Plus, X, MessageSquare, LogOut, Loader2, Cloud, CloudOff, Pin, Sliders } from 'lucide-react';
import Button from '../ui/Button.jsx';
import SidebarChatItem from './SidebarChatItem.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';
import { APP_CONFIG } from '../../config/appConfig.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';

export default function Sidebar({
  isOpen,
  onClose,
  onNewChat,
  recentChats = [],
  activeChatId = null,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onTogglePin,
  chatsLoading = false,
  isCloudSynced = false,
  isOffline = false
}) {
  const { currentUser, username, logout, actionLoading } = useAuth();
  const { openSettingsModal } = useSettings();

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const pinnedChats = recentChats.filter((c) => Boolean(c.isPinned));
  const unpinnedChats = recentChats.filter((c) => !c.isPinned);

  return (
    <aside
      className={`chatora-sidebar ${!isOpen ? 'collapsed' : ''}`}
      aria-label="Sidebar navigation"
    >
      {/* Branding & Close Toggle */}
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <OrvixLogo size={28} />
          <span className="brand-title">{APP_CONFIG.name}</span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          title="Close sidebar"
          ariaLabel="Close sidebar"
          icon={<X size={18} />}
        />
      </div>

      {/* New Chat Primary Action */}
      <div className="sidebar-actions">
        <Button
          variant="primary"
          size="md"
          onClick={onNewChat}
          icon={<Plus size={16} />}
          className="new-chat-btn"
          title="Start a fresh conversation"
        >
          New Chat
        </Button>
      </div>

      {/* Saved Conversations Section */}
      <div className="sidebar-content">
        {chatsLoading ? (
          <div className="sidebar-loading-box">
            <Loader2 size={16} className="animate-spin text-muted" />
            <span>Loading conversations...</span>
          </div>
        ) : recentChats.length === 0 ? (
          <div className="sidebar-empty-box">
            <MessageSquare size={18} className="empty-icon" />
            <p>No saved conversations yet.</p>
            <span>Messages will be stored here automatically.</span>
          </div>
        ) : (
          <>
            {/* Dedicated Pinned Conversations Section */}
            {pinnedChats.length > 0 && (
              <div className="sidebar-section pinned-chats-section">
                <div className="sidebar-section-header">
                  <div className="sidebar-section-title-wrapper flex items-center gap-1.5">
                    <Pin size={12} className="text-amber-400 rotate-45 inline" />
                    <span className="sidebar-section-title">Pinned</span>
                    <span className="sidebar-pin-count">({pinnedChats.length}/5)</span>
                  </div>
                </div>
                <nav className="recent-chats-list" aria-label="Pinned chats list">
                  {pinnedChats.map((chat) => (
                    <SidebarChatItem
                      key={chat.id}
                      chat={chat}
                      isActive={activeChatId === chat.id}
                      onSelect={() => onSelectChat && onSelectChat(chat.id)}
                      onRename={onRenameChat ? (newTitle) => onRenameChat(chat.id, newTitle) : null}
                      onDelete={onDeleteChat ? () => onDeleteChat(chat.id) : null}
                      onTogglePin={onTogglePin ? () => onTogglePin(chat.id) : null}
                    />
                  ))}
                </nav>
              </div>
            )}

            {/* Regular Chat History Section */}
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <span className="sidebar-section-title">
                  {pinnedChats.length > 0 ? 'Recent' : 'Conversations'}
                </span>
                {isCloudSynced && !isOffline ? (
                  <span className="demo-data-badge synced-badge" title="Conversations are saved to Cloud Firestore">
                    <Cloud size={11} className="inline mr-1" />
                    Synced
                  </span>
                ) : isCloudSynced && isOffline ? (
                  <span className="demo-data-badge" title="Offline: conversations are saved locally and will sync when internet reconnects">
                    <CloudOff size={11} className="inline mr-1" />
                    Offline
                  </span>
                ) : (
                  <span className="demo-data-badge" title="Conversations are stored locally on this device">
                    Local
                  </span>
                )}
              </div>

              {unpinnedChats.length === 0 && pinnedChats.length > 0 ? (
                <div className="sidebar-empty-subtext">
                  <span>All conversations are pinned above.</span>
                </div>
              ) : (
                <nav className="recent-chats-list" aria-label="Recent chats list">
                  {unpinnedChats.map((chat) => (
                    <SidebarChatItem
                      key={chat.id}
                      chat={chat}
                      isActive={activeChatId === chat.id}
                      onSelect={() => onSelectChat && onSelectChat(chat.id)}
                      onRename={onRenameChat ? (newTitle) => onRenameChat(chat.id, newTitle) : null}
                      onDelete={onDeleteChat ? () => onDeleteChat(chat.id) : null}
                      onTogglePin={onTogglePin ? () => onTogglePin(chat.id) : null}
                    />
                  ))}
                </nav>
              )}
            </div>
          </>
        )}
      </div>

      {/* Sidebar Footer with Auth Status */}
      <div className="sidebar-footer">
        {currentUser ? (
          <div className="sidebar-user-card">
            <div className="sidebar-user-details">
              <span className="status-dot" aria-hidden="true" />
              <div className="sidebar-user-text">
                <span className="user-email-text" title={username || currentUser.email || ''}>
                  {username || (currentUser.isAnonymous ? 'Guest Explorer' : currentUser.email)}
                </span>
                <span className="user-state-text">
                  {username && currentUser.email ? currentUser.email : currentUser.isAnonymous ? 'Demo session' : 'Active session'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="sidebar-logout-btn sidebar-settings-trigger"
                onClick={openSettingsModal}
                title="Personalization Settings"
                aria-label="Personalization Settings"
              >
                <Sliders size={14} />
              </button>
              <button
                type="button"
                className="sidebar-logout-btn"
                onClick={handleLogout}
                disabled={actionLoading}
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div className="sidebar-user-card">
            <div className="user-status">
              <span className="status-dot" aria-hidden="true" />
              <div className="status-text-block">
                <span className="status-label">Orvix v{APP_CONFIG.version}</span>
                <span className="status-sublabel">Authentication active</span>
              </div>
            </div>
            <button
              type="button"
              className="sidebar-logout-btn sidebar-settings-trigger"
              onClick={openSettingsModal}
              title="Personalization Settings"
              aria-label="Personalization Settings"
            >
              <Sliders size={14} />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
