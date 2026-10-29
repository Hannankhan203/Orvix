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
  hasExportableMessages = false,
  isOffline = false,
  providerConfig = null,
  selectedModelId = undefined
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

  // Synchronize visualViewport height & virtual keyboard state on mobile/tablet browsers and PWAs
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    const root = document.documentElement;
    let rafId = null;
    let lastAppliedHeight = 0;
    let maxObservedInnerHeight = window.innerHeight || 0;

    const isEditableElement = (el) => {
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === 'textarea' || tag === 'select') return true;
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
      }
      return Boolean(el.isContentEditable || el.getAttribute?.('contenteditable') === 'true');
    };

    const updateViewportMetrics = () => {
      rafId = null;
      const innerH = window.innerHeight || 0;
      if (innerH > maxObservedInnerHeight || Math.abs(window.innerWidth - (root._lastVw || window.innerWidth)) > 80) {
        maxObservedInnerHeight = innerH;
        root._lastVw = window.innerWidth;
      }

      if (window.innerWidth > 1024 || !vv) {
        if (lastAppliedHeight !== 0) {
          root.style.removeProperty('--app-viewport-height');
          lastAppliedHeight = 0;
        }
        root.classList.remove('is-keyboard-open');
        return;
      }

      // Ignore pinch-zoom scaling so zoomed viewports do not corrupt layout height
      if (vv.scale && vv.scale > 1.02) {
        return;
      }

      const currentHeight = Math.round(vv.height);
      if (currentHeight > 0 && Math.abs(currentHeight - lastAppliedHeight) >= 2) {
        root.style.setProperty('--app-viewport-height', `${currentHeight}px`);
        lastAppliedHeight = currentHeight;
      }

      const referenceHeight = Math.max(innerH, maxObservedInnerHeight);
      const heightDelta = referenceHeight - currentHeight;
      const activeFocused = isEditableElement(document.activeElement);
      const keyboardOpen = heightDelta > 115 || (activeFocused && heightDelta > 68);

      if (keyboardOpen) {
        root.classList.add('is-keyboard-open');
        // Prevent iOS Safari / standalone PWA from scrolling the document body upward above the viewport
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0);
        }
      } else {
        root.classList.remove('is-keyboard-open');
      }
    };

    const scheduleViewportUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateViewportMetrics);
    };

    const handleFocusChange = () => {
      scheduleViewportUpdate();
      setTimeout(scheduleViewportUpdate, 120);
      setTimeout(scheduleViewportUpdate, 300);
    };

    updateViewportMetrics();

    if (vv) {
      vv.addEventListener('resize', scheduleViewportUpdate);
      vv.addEventListener('scroll', scheduleViewportUpdate);
    }
    window.addEventListener('resize', scheduleViewportUpdate);
    window.addEventListener('orientationchange', scheduleViewportUpdate);
    document.addEventListener('focusin', handleFocusChange);
    document.addEventListener('focusout', handleFocusChange);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (vv) {
        vv.removeEventListener('resize', scheduleViewportUpdate);
        vv.removeEventListener('scroll', scheduleViewportUpdate);
      }
      window.removeEventListener('resize', scheduleViewportUpdate);
      window.removeEventListener('orientationchange', scheduleViewportUpdate);
      document.removeEventListener('focusin', handleFocusChange);
      document.removeEventListener('focusout', handleFocusChange);
      root.style.removeProperty('--app-viewport-height');
      root.classList.remove('is-keyboard-open');
    };
  }, []);

  // Lock background body scrolling when mobile drawer is open (without blocking touch scrolling inside the sidebar)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isMobile = window.innerWidth < 768;
    if (sidebarOpen && isMobile) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [sidebarOpen]);

  // Manage focus when opening/closing the mobile drawer on small screens
  const prevSidebarOpenRef = useRef(sidebarOpen);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isMobile = window.innerWidth < 768;
    if (isMobile && prevSidebarOpenRef.current !== sidebarOpen) {
      if (sidebarOpen) {
        requestAnimationFrame(() => {
          const sidebarEl = document.querySelector('.chatora-sidebar');
          const closeBtn = sidebarEl?.querySelector('.sidebar-collapse-btn');
          closeBtn?.focus({ preventScroll: true });
        });
      } else {
        requestAnimationFrame(() => {
          const menuBtn = document.querySelector('.mobile-menu-btn');
          menuBtn?.focus({ preventScroll: true });
        });
      }
    }
    prevSidebarOpenRef.current = sidebarOpen;
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

  // Mobile/Tablet swipe gestures:
  // - Swipe right across main chat viewport to open sidebar when closed
  // - Swipe left on open mobile sidebar/backdrop to dismiss drawer
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Minimum distance from left screen edge to avoid conflicting with iPhone native Back gesture
    const IOS_EDGE_MARGIN_PX = 16;
    // Minimum horizontal movement required to open sidebar
    const MIN_SWIPE_PX = 50;
    // Quick flick distance and velocity threshold
    const FLICK_DISTANCE_PX = 30;
    const FLICK_VELOCITY = 0.35;
    // Initial movement threshold before determining horizontal swipe vs vertical scroll
    const INTENT_THRESHOLD_PX = 10;

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

    /**
     * Determines whether a touch target is in an excluded zone:
     * - Left edge zone (< 16px) reserved for iOS native Back gesture
     * - Top Navigation / Action Bar (header)
     * - Bottom Composer area (inputs, buttons, dictation, attachments)
     * - Interactive controls (buttons, links, inputs, dialogs, popovers)
     * - Horizontally scrollable elements (code blocks, tables, chips)
     * - Active text selection
     */
    const isExcludedSwipeTarget = (target, clientX) => {
      if (!target || !target.closest) return true;

      // 1. Native iOS Back gesture avoidance zone at extreme left edge
      if (typeof clientX === 'number' && clientX < IOS_EDGE_MARGIN_PX) {
        return true;
      }

      // 2. Exclude Top Navigation Bar / Header controls
      if (target.closest('header, .chatora-header-wrapper, .header-desktop-view, .header-mobile-view')) {
        return true;
      }

      // 3. Exclude Bottom Composer Area & Composer Dock
      if (
        target.closest(
          '.chat-composer-dock, .chat-composer-inner, .composer-form, .composer-attachments-preview, .dictation-strip, .transcript-review-card, .transcript-cleanup-banner, .scroll-to-bottom-dock'
        )
      ) {
        return true;
      }

      // 4. Exclude Interactive Elements, form inputs, buttons, dialogs, popovers, and menus
      if (
        target.closest(
          'button, a, input, textarea, select, [role="button"], [role="dialog"], [role="menu"], [role="menuitem"], [role="tab"], [contenteditable="true"]'
        )
      ) {
        return true;
      }

      // 5. Exclude Horizontally Scrollable Elements (code blocks, data tables, scrollable pills)
      if (
        target.closest(
          '.table-responsive-wrapper, .markdown-table, .code-block-container, pre, code, .prompt-suggestions-scroll, .alternative-nav-wrapper, .dictation-lang-dropdown'
        )
      ) {
        return true;
      }

      // 6. Active text selection check
      try {
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
          return true;
        }
      } catch (_) {}

      // 7. Touch must be within the main viewport/chat container
      if (!target.closest('.chat-scroll-viewport, .chat-area-container, .chatora-main')) {
        return true;
      }

      return false;
    };

    // --- Native Touch Event Handlers ---
    const handleTouchStart = (e) => {
      if (window.innerWidth > 1024) return;
      if (!e.touches || e.touches.length !== 1) return;

      const touch = e.touches[0];
      const clientX = touch.clientX;
      const clientY = touch.clientY;

      if (sidebarOpenRef.current) {
        // When drawer is open (mobile or touch tablet <= 1024px), allow swipe-left on sidebar or backdrop to close
        if (window.innerWidth > 1024) return;
        if (!e.target?.closest?.('.chatora-sidebar, .sidebar-backdrop')) return;
        if (e.target?.closest?.('input, textarea, select')) return;
      } else {
        if (isExcludedSwipeTarget(e.target, clientX)) return;
      }

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
        // Evaluate initial intent once movement exceeds INTENT_THRESHOLD_PX
        if (absX >= INTENT_THRESHOLD_PX || absY >= INTENT_THRESHOLD_PX) {
          const isValidDirection = sidebarOpenRef.current ? deltaX < 0 : deltaX > 0;
          if (isValidDirection && absX > absY * 1.25) {
            isHorizontalTouchSwipe = true;
          } else {
            // Predominantly vertical scrolling or opposite-direction swipe:
            // Release tracking immediately so native vertical scrolling continues completely uninterrupted
            resetTouchGesture();
            return;
          }
        }
      }

      // Once confirmed as an intentional horizontal drawer swipe, prevent vertical scroll contention
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

      if (sidebarOpenRef.current) {
        const isQualifyingCloseSwipe =
          deltaX < 0 &&
          absX > absY &&
          (deltaX <= -MIN_SWIPE_PX || (deltaX <= -FLICK_DISTANCE_PX && velocityX < -FLICK_VELOCITY));
        if (isQualifyingCloseSwipe) {
          setSidebarOpen(false);
        }
      } else {
        // Open sidebar if horizontal swipe crossed threshold or was a fast rightward flick
        const isQualifyingOpenSwipe =
          deltaX > 0 &&
          absX > absY &&
          (deltaX >= MIN_SWIPE_PX || (deltaX >= FLICK_DISTANCE_PX && velocityX > FLICK_VELOCITY));

        if (isQualifyingOpenSwipe) {
          setSidebarOpen(true);
        }
      }

      resetTouchGesture();
    };

    const handleTouchCancel = () => {
      resetTouchGesture();
    };

    // --- Pointer Event Handlers (for environments dispatching PointerEvents / synthetic tests) ---
    const handlePointerDown = (e) => {
      // If a native touch gesture is already tracking, ignore pointer events completely
      if (isTrackingTouch) return;
      if (sidebarOpenRef.current || window.innerWidth > 1024) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const clientX = e.clientX;
      const clientY = e.clientY;

      if (isExcludedSwipeTarget(e.target, clientX)) return;

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
          if (deltaX > 0 && absX > absY * 1.25) {
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

      const isQualifyingSwipe =
        deltaX > 0 &&
        absX > absY &&
        (deltaX >= MIN_SWIPE_PX || (deltaX >= FLICK_DISTANCE_PX && velocityX > FLICK_VELOCITY));

      if (isQualifyingSwipe && !sidebarOpenRef.current) {
        setSidebarOpen(true);
      }

      resetPointerGesture();
    };

    const handlePointerCancel = (e) => {
      if (e.pointerId === activePointerId) {
        resetPointerGesture();
      }
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
    <div className={`chatora-app ${sidebarOpen ? 'sidebar-is-open' : 'sidebar-is-collapsed'}`}>
      {/* Mobile/Tablet backdrop with smooth fade in and fade out */}
      <div
        className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`}
        onClick={closeSidebar}
        aria-hidden={!sidebarOpen ? 'true' : undefined}
      />

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
        isOffline={isOffline}
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
          providerConfig={providerConfig}
          selectedModelId={selectedModelId}
        />
        {children}
      </div>
    </div>
  );
}
