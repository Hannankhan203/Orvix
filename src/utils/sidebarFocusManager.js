/**
 * Sidebar Focus & Accessibility Management Utilities
 *
 * Ensures keyboard focus is evacuated out of `aside.chatora-sidebar` BEFORE
 * `aria-hidden="true"` / `inert` are applied when collapsing or closing the sidebar,
 * preventing Chromium's "Blocked aria-hidden on an element because its descendant
 * retained focus" violation while preserving natural keyboard navigation across
 * desktop and mobile layouts.
 */

/**
 * Checks whether an element and all of its ancestors are visible and able to receive focus.
 *
 * @param {any} el
 * @param {Window | null} [win]
 * @returns {boolean}
 */
export function isElementVisibleAndFocusable(
  el,
  win = typeof window !== 'undefined' ? window : null
) {
  if (!el || typeof el.focus !== 'function') return false;
  if (el.disabled) return false;

  let current = el;
  while (current && current.nodeType === 1) {
    if (current.getAttribute?.('aria-hidden') === 'true' || Boolean(current.inert)) {
      return false;
    }

    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const style = win.getComputedStyle(current);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) {
          return false;
        }
      } catch (_) {
        // Ignore computedStyle lookup errors in minimal non-browser test environments
      }
    }

    current = current.parentElement || null;
  }

  return true;
}

/**
 * Selects the appropriate visible interactive element outside the sidebar
 * to receive focus when the sidebar collapses or closes.
 *
 * @param {Object} options
 * @param {any} [options.desktopToggleEl]
 * @param {any} [options.mobileToggleEl]
 * @param {any} [options.fallbackEl]
 * @param {number} [options.viewportWidth]
 * @param {Window | null} [options.win]
 * @returns {any | null}
 */
export function resolveExternalSidebarFocusTarget({
  desktopToggleEl = null,
  mobileToggleEl = null,
  fallbackEl = null,
  viewportWidth,
  win = typeof window !== 'undefined' ? window : null
} = {}) {
  const width =
    typeof viewportWidth === 'number'
      ? viewportWidth
      : win && typeof win.innerWidth === 'number'
      ? win.innerWidth
      : 1024;

  const isMobileViewport = width < 768;
  const candidates = isMobileViewport
    ? [mobileToggleEl, desktopToggleEl, fallbackEl]
    : [desktopToggleEl, mobileToggleEl, fallbackEl];

  for (const candidate of candidates) {
    if (isElementVisibleAndFocusable(candidate, win)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Moves focus out of `sidebarEl` to the visible external sidebar toggle control
 * if and only if focus is currently inside `sidebarEl`.
 * If no external target can accept focus, blurs the focused descendant so focus
 * is never retained inside an `aria-hidden` sidebar.
 *
 * @param {Object} options
 * @param {any} options.sidebarEl
 * @param {any} [options.desktopToggleEl]
 * @param {any} [options.mobileToggleEl]
 * @param {any} [options.fallbackEl]
 * @param {Document | null} [options.doc]
 * @param {Window | null} [options.win]
 * @param {number} [options.viewportWidth]
 * @returns {{ moved: boolean, target: any | null }}
 */
export function evacuateSidebarFocus({
  sidebarEl,
  desktopToggleEl = null,
  mobileToggleEl = null,
  fallbackEl = null,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
  viewportWidth
} = {}) {
  if (!sidebarEl || !doc) {
    return { moved: false, target: null };
  }

  const activeEl = doc.activeElement;
  if (!activeEl || typeof sidebarEl.contains !== 'function' || !sidebarEl.contains(activeEl)) {
    return { moved: false, target: null };
  }

  const target = resolveExternalSidebarFocusTarget({
    desktopToggleEl,
    mobileToggleEl,
    fallbackEl,
    viewportWidth,
    win
  });

  if (target) {
    target.focus({ preventScroll: true });
  }

  // Defensive fallback: if focus still remained inside the sidebar (e.g. standalone render
  // without Header), blur the active descendant so aria-hidden is never blocked.
  if (sidebarEl.contains(doc.activeElement) && typeof activeEl.blur === 'function') {
    activeEl.blur();
  }

  return {
    moved: true,
    target: !sidebarEl.contains(doc.activeElement) ? target : null
  };
}
