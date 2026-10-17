import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';

/**
 * Layout Component
 * Manages responsive application shell, sidebar visibility, model selector, and content slots.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {() => void} props.onNewChat
 * @param {Array} [props.recentChats=[]]
 * @param {string|null} [props.activeChatId=null]
 * @param {(chatId: string) => void} [props.onSelectChat]
 * @param {(chatId: string, newTitle: string) => Promise<void>} [props.onRenameChat]
 * @param {(chatId: string) => Promise<void>} [props.onDeleteChat]
 * @param {string|null} [props.activeTitle=null]
 * @param {boolean} [props.chatsLoading=false]
 * @param {boolean} [props.isCloudSynced=false]
 * @param {string} [props.selectedProvider='gemini']
 * @param {(provider: string) => void} [props.onSelectProvider]
 */
export default function Layout({
  children,
  onNewChat,
  recentChats = [],
  activeChatId = null,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onTogglePin,
  activeTitle = null,
  chatsLoading = false,
  isCloudSynced = false,
  selectedProvider = 'gemini',
  onSelectProvider
}) {
  // Desktop defaults to open, mobile defaults to closed
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768;
    }
    return true;
  });

  // Handle responsive resizing
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768 && sidebarOpen) {
        setSidebarOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [sidebarOpen]);

  // Lock background body scrolling when mobile drawer is open
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isMobile = window.innerWidth < 768;
    if (sidebarOpen && isMobile) {
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
    } else {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    };
  }, [sidebarOpen]);

  // Handle Escape key to close mobile sidebar
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && sidebarOpen && window.innerWidth < 768) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen]);

  const toggleSidebar = () => {
    setSidebarOpen((prev) => !prev);
  };

  const closeSidebar = () => {
    setSidebarOpen(false);
  };

  const handleSelectChat = (chatId) => {
    if (onSelectChat) {
      onSelectChat(chatId);
    }
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  const handleNewChat = () => {
    if (onNewChat) {
      onNewChat();
    }
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  return (
    <div className="chatora-app">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* Collapsible Sidebar */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onNewChat={handleNewChat}
        recentChats={recentChats}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onRenameChat={onRenameChat}
        onDeleteChat={onDeleteChat}
        onTogglePin={onTogglePin}
        chatsLoading={chatsLoading}
        isCloudSynced={isCloudSynced}
      />

      {/* Main Viewport */}
      <div className="chatora-main">
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          onNewChat={handleNewChat}
          activeTitle={activeTitle}
          selectedProvider={selectedProvider}
          onSelectProvider={onSelectProvider}
        />
        {children}
      </div>
    </div>
  );
}
