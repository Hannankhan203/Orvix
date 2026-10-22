import React, { useState, useEffect, useRef } from 'react';
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

  // Keep a ref to sidebarOpen to avoid tearing down and re-binding gesture listeners on state updates
  const sidebarOpenRef = useRef(sidebarOpen);
  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  // Mobile/Tablet left-edge swipe-right gesture to open previous chat list/sidebar
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Edge activation zone: gesture must start within ~40px from the left screen edge
    const EDGE_ZONE_PX = 40;
    // Minimum horizontal movement distance required to trigger opening the sidebar
    const MIN_SWIPE_PX = 40;
    // Initial movement threshold before determining horizontal vs vertical intent
    const INTENT_THRESHOLD_PX = 8;

    // --- Isolated Touch State ---
    let touchStartX = null;
    let touchStartY = null;
    let touchCurrentX = null;
    let touchCurrentY = null;
    let touchStartTime = 0;
    let isTrackingTouch = false;
    let isHorizontalTouchSwipe = false;

    const resetTouchGesture = () => {
      touchStartX = null;
      touchStartY = null;
      touchCurrentX = null;
      touchCurrentY = null;
      touchStartTime = 0;
      isTrackingTouch = false;
      isHorizontalTouchSwipe = false;
    };

    // --- Isolated Pointer State (for pointer devices / synthetic test dispatchers) ---
    let pointerStartX = null;
    let pointerStartY = null;
    let pointerCurrentX = null;
    let pointerCurrentY = null;
    let pointerStartTime = 0;
    let isTrackingPointer = false;
    let isHorizontalPointerSwipe = false;
    let activePointerId = null;

    const resetPointerGesture = () => {
      pointerStartX = null;
      pointerStartY = null;
      pointerCurrentX = null;
      pointerCurrentY = null;
      pointerStartTime = 0;
      isTrackingPointer = false;
      isHorizontalPointerSwipe = false;
      activePointerId = null;
    };

    const isInteractiveElement = (target) => {
      if (!target || !target.closest) return false;
      return Boolean(
        target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]')
      );
    };

    // --- Native Touch Event Handlers ---
    const handleTouchStart = (e) => {
      // Gesture only applies when sidebar is closed and on mobile/tablet screens (width <= 1024px)
      if (sidebarOpenRef.current || window.innerWidth > 1024) return;
      if (!e.touches || e.touches.length !== 1) return;

      const touch = e.touches[0];
      const clientX = touch.clientX;
      const clientY = touch.clientY;

      // Must start near the left edge (0 to 40px)
      if (clientX < 0 || clientX > EDGE_ZONE_PX) return;
      // Do not capture if touch starts on form inputs or interactive controls
      if (isInteractiveElement(e.target)) return;

      touchStartX = clientX;
      touchStartY = clientY;
      touchCurrentX = clientX;
      touchCurrentY = clientY;
      touchStartTime = Date.now();
      isTrackingTouch = true;
      isHorizontalTouchSwipe = false;

      // Silence any lingering pointer gesture tracking
      resetPointerGesture();
    };

    const handleTouchMove = (e) => {
      if (!isTrackingTouch || touchStartX === null || touchStartY === null) return;
      if (!e.touches || e.touches.length !== 1) return;

      const touch = e.touches[0];
      touchCurrentX = touch.clientX;
      touchCurrentY = touch.clientY;

      const deltaX = touchCurrentX - touchStartX;
      const deltaY = touchCurrentY - touchStartY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (!isHorizontalTouchSwipe) {
        if (absX >= INTENT_THRESHOLD_PX || absY >= INTENT_THRESHOLD_PX) {
          // If predominantly moving rightward
          if (deltaX > 0 && absX > absY) {
            isHorizontalTouchSwipe = true;
          } else {
            // Predominantly vertical scrolling or leftward movement:
            // Release tracking immediately to allow seamless vertical scrolling
            resetTouchGesture();
            return;
          }
        }
      }

      // Once confirmed horizontal swipe from the edge, prevent default scroll contention
      if (isHorizontalTouchSwipe && e.cancelable) {
        e.preventDefault();
      }
    };

    const handleTouchEnd = (e) => {
      if (!isTrackingTouch || touchStartX === null || touchStartY === null) {
        resetTouchGesture();
        return;
      }

      const touch = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
      const endX = touch ? touch.clientX : (touchCurrentX ?? touchStartX);
      const endY = touch ? touch.clientY : (touchCurrentY ?? touchStartY);

      const deltaX = endX - touchStartX;
      const deltaY = endY - touchStartY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const duration = Math.max(Date.now() - touchStartTime, 1);
      const velocityX = deltaX / duration;

      // Open sidebar if horizontal swipe crossed threshold or was a fast rightward flick
      if ((deltaX >= MIN_SWIPE_PX || (deltaX >= 25 && velocityX > 0.3)) && absX > absY) {
        setSidebarOpen(true);
      }

      resetTouchGesture();
    };

    const handleTouchCancel = () => {
      if (isTrackingTouch && isHorizontalTouchSwipe && touchStartX !== null && touchCurrentX !== null) {
        const deltaX = touchCurrentX - touchStartX;
        const deltaY = (touchCurrentY ?? touchStartY) - touchStartY;
        if (deltaX >= MIN_SWIPE_PX && deltaX > Math.abs(deltaY)) {
          setSidebarOpen(true);
        }
      }
      resetTouchGesture();
    };

    // --- Pointer Event Handlers (for environments dispatching PointerEvents) ---
    const handlePointerDown = (e) => {
      // If a native touch gesture is already tracking, ignore pointer events completely
      if (isTrackingTouch) return;
      if (sidebarOpenRef.current || window.innerWidth > 1024) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const clientX = e.clientX;
      const clientY = e.clientY;

      if (clientX < 0 || clientX > EDGE_ZONE_PX) return;
      if (isInteractiveElement(e.target)) return;

      pointerStartX = clientX;
      pointerStartY = clientY;
      pointerCurrentX = clientX;
      pointerCurrentY = clientY;
      pointerStartTime = Date.now();
      isTrackingPointer = true;
      isHorizontalPointerSwipe = false;
      activePointerId = e.pointerId;
    };

    const handlePointerMove = (e) => {
      if (isTrackingTouch) {
        resetPointerGesture();
        return;
      }
      if (!isTrackingPointer || e.pointerId !== activePointerId || pointerStartX === null || pointerStartY === null) return;

      pointerCurrentX = e.clientX;
      pointerCurrentY = e.clientY;

      const deltaX = pointerCurrentX - pointerStartX;
      const deltaY = pointerCurrentY - pointerStartY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (!isHorizontalPointerSwipe) {
        if (absX >= INTENT_THRESHOLD_PX || absY >= INTENT_THRESHOLD_PX) {
          if (deltaX > 0 && absX > absY) {
            isHorizontalPointerSwipe = true;
          } else {
            resetPointerGesture();
            return;
          }
        }
      }

      if (isHorizontalPointerSwipe && e.cancelable) {
        e.preventDefault();
      }
    };

    const handlePointerUp = (e) => {
      if (isTrackingTouch) {
        resetPointerGesture();
        return;
      }
      if (!isTrackingPointer || e.pointerId !== activePointerId || pointerStartX === null || pointerStartY === null) {
        resetPointerGesture();
        return;
      }

      const deltaX = e.clientX - pointerStartX;
      const deltaY = e.clientY - pointerStartY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const duration = Math.max(Date.now() - pointerStartTime, 1);
      const velocityX = deltaX / duration;

      if ((deltaX >= MIN_SWIPE_PX || (deltaX >= 25 && velocityX > 0.3)) && absX > absY) {
        setSidebarOpen(true);
      }

      resetPointerGesture();
    };

    const handlePointerCancel = (e) => {
      if (e.pointerId !== activePointerId) return;
      // Only process pointer cancel if native touch is not handling it
      if (!isTrackingTouch && isTrackingPointer && isHorizontalPointerSwipe && pointerStartX !== null && pointerCurrentX !== null) {
        const deltaX = pointerCurrentX - pointerStartX;
        const deltaY = (pointerCurrentY ?? pointerStartY) - pointerStartY;
        if (deltaX >= MIN_SWIPE_PX && deltaX > Math.abs(deltaY)) {
          setSidebarOpen(true);
        }
      }
      resetPointerGesture();
    };

    const handleWindowBlur = () => {
      resetTouchGesture();
      resetPointerGesture();
    };

    // Register event listeners
    window.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    window.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
    window.addEventListener('touchcancel', handleTouchCancel, { capture: true, passive: true });

    window.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
    window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
    window.addEventListener('pointerup', handlePointerUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true, passive: true });

    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('touchstart', handleTouchStart, { capture: true });
      window.removeEventListener('touchmove', handleTouchMove, { capture: true });
      window.removeEventListener('touchend', handleTouchEnd, { capture: true });
      window.removeEventListener('touchcancel', handleTouchCancel, { capture: true });

      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('pointermove', handlePointerMove, { capture: true });
      window.removeEventListener('pointerup', handlePointerUp, { capture: true });
      window.removeEventListener('pointercancel', handlePointerCancel, { capture: true });

      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

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
