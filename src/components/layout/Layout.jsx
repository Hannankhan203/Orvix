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
  onSelectProvider,
  activeMode = 'general',
  onSelectMode,
  onExportMarkdown,
  onExportText,
  hasExportableMessages = false
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

  // Mobile/Tablet left-edge swipe-right gesture to open previous chat list
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const EDGE_ZONE_PX = 40; // Gesture must start within 40px of left screen edge
    const MIN_SWIPE_PX = 50;  // Must swipe at least 50px horizontally to the right
    let startX = null;
    let startY = null;
    let isEdgeSwipe = false;
    let isHorizontalGesture = false;

    const handleTouchStart = (e) => {
      // Gesture only applies when sidebar is closed and on mobile/tablet screen sizes
      if (sidebarOpen || window.innerWidth >= 1024) return;
      if (!e.touches || e.touches.length !== 1) return;

      const touch = e.touches[0];
      // Only initiate if touch begins within the left edge zone
      if (touch.clientX > EDGE_ZONE_PX) return;

      // Do not interfere if user tapped an interactive form input or element
      const target = e.target;
      if (target && target.closest && target.closest('input, textarea, [contenteditable="true"], select')) {
        return;
      }

      startX = touch.clientX;
      startY = touch.clientY;
      isEdgeSwipe = true;
      isHorizontalGesture = false;
    };

    const handleTouchMove = (e) => {
      if (!isEdgeSwipe || startX === null || startY === null) return;
      if (!e.touches || e.touches.length !== 1) return;

      const touch = e.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      // Determine gesture direction once a small movement threshold is crossed
      if (!isHorizontalGesture) {
        if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
          // If vertical movement dominates, user is scrolling - cancel edge swipe immediately
          if (Math.abs(deltaY) >= Math.abs(deltaX)) {
            isEdgeSwipe = false;
            return;
          }
          // If swiping rightward from edge, lock as valid horizontal swipe
          if (deltaX > 10) {
            isHorizontalGesture = true;
          } else {
            // Swiped leftwards off-screen
            isEdgeSwipe = false;
            return;
          }
        }
      }
    };

    const handleTouchEnd = (e) => {
      if (!isEdgeSwipe || !isHorizontalGesture || startX === null || startY === null) {
        isEdgeSwipe = false;
        startX = null;
        startY = null;
        isHorizontalGesture = false;
        return;
      }

      const touch = e.changedTouches && e.changedTouches[0];
      if (touch) {
        const deltaX = touch.clientX - startX;
        const deltaY = touch.clientY - startY;

        // If swipe distance is sufficient and movement was predominantly horizontal
        if (deltaX >= MIN_SWIPE_PX && deltaX > Math.abs(deltaY) * 1.2) {
          setSidebarOpen(true);
        }
      }

      isEdgeSwipe = false;
      startX = null;
      startY = null;
      isHorizontalGesture = false;
    };

    const handleTouchCancel = () => {
      isEdgeSwipe = false;
      startX = null;
      startY = null;
      isHorizontalGesture = false;
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchCancel);
    };
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
          activeMode={activeMode}
          onSelectMode={onSelectMode}
          onExportMarkdown={onExportMarkdown}
          onExportText={onExportText}
          hasExportableMessages={hasExportableMessages}
        />
        {children}
      </div>
    </div>
  );
}
