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

  // Mobile/Tablet left-edge swipe-right gesture to open previous chat list/sidebar
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Edge activation zone: gesture must start within 36px from left screen edge
    const EDGE_ZONE_PX = 36;
    // Minimum horizontal distance required to trigger opening the sidebar
    const MIN_SWIPE_PX = 45;
    // Minimum displacement before determining horizontal vs vertical intent
    const INTENT_THRESHOLD_PX = 8;

    let startX = null;
    let startY = null;
    let currentX = null;
    let currentY = null;
    let isTracking = false;
    let isHorizontalSwipe = false;
    let activePointerId = null;

    const resetGesture = () => {
      startX = null;
      startY = null;
      currentX = null;
      currentY = null;
      isTracking = false;
      isHorizontalSwipe = false;
      activePointerId = null;
    };

    const isInteractiveElement = (target) => {
      if (!target || !target.closest) return false;
      return Boolean(
        target.closest('input, textarea, select, button, a, [contenteditable="true"]')
      );
    };

    // --- Touch Events Handler ---
    const handleTouchStart = (e) => {
      // Gesture only applies when sidebar is closed and on mobile/tablet screen sizes (< 1024px)
      if (sidebarOpen || window.innerWidth >= 1024) return;
      if (!e.touches || e.touches.length !== 1) return;

      const touch = e.touches[0];
      const clientX = touch.clientX;
      const clientY = touch.clientY;

      // Must start near the left edge (within EDGE_ZONE_PX)
      if (clientX < 0 || clientX > EDGE_ZONE_PX) return;

      // Do not capture if touch starts on form inputs or interactive elements
      if (isInteractiveElement(e.target)) return;

      startX = clientX;
      startY = clientY;
      currentX = clientX;
      currentY = clientY;
      isTracking = true;
      isHorizontalSwipe = false;
    };

    const handleTouchMove = (e) => {
      if (!isTracking || startX === null || startY === null) return;
      if (!e.touches || e.touches.length !== 1) return;

      const touch = e.touches[0];
      currentX = touch.clientX;
      currentY = touch.clientY;

      const deltaX = currentX - startX;
      const deltaY = currentY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Determine gesture direction once past initial movement threshold
      if (!isHorizontalSwipe) {
        if (absX >= INTENT_THRESHOLD_PX || absY >= INTENT_THRESHOLD_PX) {
          // If swiping rightward and horizontal displacement exceeds vertical
          if (deltaX > 0 && absX > absY * 1.1) {
            isHorizontalSwipe = true;
          } else if (absY > absX * 1.2 || deltaX < -5) {
            // Clearly vertical scroll or leftward movement: cancel tracking
            // and let browser continue normal smooth vertical scrolling
            resetGesture();
            return;
          }
        }
      }

      // If locked into horizontal swipe from the edge, prevent default to stop
      // the browser from firing touchcancel or page navigation
      if (isHorizontalSwipe && e.cancelable) {
        e.preventDefault();
      }
    };

    const handleTouchEnd = (e) => {
      if (!isTracking || startX === null || startY === null) {
        resetGesture();
        return;
      }

      const touch = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
      const endX = touch ? touch.clientX : (currentX ?? startX);
      const endY = touch ? touch.clientY : (currentY ?? startY);

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Trigger sidebar open if horizontal swipe crossed threshold and is predominantly rightward
      if (deltaX >= MIN_SWIPE_PX && absX > absY * 1.1) {
        setSidebarOpen(true);
      }

      resetGesture();
    };

    const handleTouchCancel = () => {
      // If a strong horizontal swipe already crossed the distance threshold before cancel,
      // still honor the swipe open
      if (isTracking && isHorizontalSwipe && startX !== null && currentX !== null) {
        const deltaX = currentX - startX;
        const deltaY = (currentY ?? startY) - startY;
        if (deltaX >= MIN_SWIPE_PX && deltaX > Math.abs(deltaY) * 1.1) {
          setSidebarOpen(true);
        }
      }
      resetGesture();
    };

    // --- Pointer Events Handler (for touch pointer support) ---
    const handlePointerDown = (e) => {
      if (e.pointerType !== 'touch') return;
      if (sidebarOpen || window.innerWidth >= 1024) return;
      if (isTracking) return;

      const clientX = e.clientX;
      const clientY = e.clientY;

      if (clientX < 0 || clientX > EDGE_ZONE_PX) return;
      if (isInteractiveElement(e.target)) return;

      startX = clientX;
      startY = clientY;
      currentX = clientX;
      currentY = clientY;
      isTracking = true;
      isHorizontalSwipe = false;
      activePointerId = e.pointerId;
    };

    const handlePointerMove = (e) => {
      if (e.pointerType !== 'touch' || !isTracking || e.pointerId !== activePointerId) return;
      currentX = e.clientX;
      currentY = e.clientY;

      const deltaX = currentX - startX;
      const deltaY = currentY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (!isHorizontalSwipe) {
        if (absX >= INTENT_THRESHOLD_PX || absY >= INTENT_THRESHOLD_PX) {
          if (deltaX > 0 && absX > absY * 1.1) {
            isHorizontalSwipe = true;
          } else if (absY > absX * 1.2 || deltaX < -5) {
            resetGesture();
            return;
          }
        }
      }
    };

    const handlePointerUp = (e) => {
      if (e.pointerType !== 'touch' || !isTracking || e.pointerId !== activePointerId) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (deltaX >= MIN_SWIPE_PX && absX > absY * 1.1) {
        setSidebarOpen(true);
      }

      resetGesture();
    };

    const handlePointerCancel = (e) => {
      if (e.pointerType !== 'touch' || e.pointerId !== activePointerId) return;
      handleTouchCancel();
    };

    // Register event listeners
    // touchmove requires { passive: false } to allow e.preventDefault() during active horizontal swipe
    window.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    window.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
    window.addEventListener('touchcancel', handleTouchCancel, { capture: true, passive: true });

    window.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
    window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
    window.addEventListener('pointerup', handlePointerUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true, passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart, { capture: true });
      window.removeEventListener('touchmove', handleTouchMove, { capture: true });
      window.removeEventListener('touchend', handleTouchEnd, { capture: true });
      window.removeEventListener('touchcancel', handleTouchCancel, { capture: true });

      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('pointermove', handlePointerMove, { capture: true });
      window.removeEventListener('pointerup', handlePointerUp, { capture: true });
      window.removeEventListener('pointercancel', handlePointerCancel, { capture: true });
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
