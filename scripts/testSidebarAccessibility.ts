/**
 * Orvix Sidebar Focus & `aria-hidden` Accessibility Regression Test Suite
 *
 * Verifies:
 *  1. Rendered accessibility structure for Sidebar, Header, and Layout across expanded/collapsed
 *     desktop and mobile viewports (`aria-hidden`, `inert`, `aria-expanded`, `aria-controls="orvix-sidebar"`,
 *     and visible expand/open toggle controls placed outside `aside.chatora-sidebar`).
 *  2. Exact reproduction & prevention of Chromium's console warning:
 *     `Blocked aria-hidden on an element because its descendant retained focus.`
 *     when `.sidebar-collapse-btn` (or any descendant of `aside.chatora-sidebar`) holds focus and
 *     the sidebar collapses on desktop (>= 768px) or closes on mobile (< 768px).
 *  3. Ancestor `display: none` / `visibility: hidden` & `aria-hidden` / `inert` awareness so
 *     desktop collapses focus `.desktop-sidebar-toggle-btn` and mobile closes focus `.mobile-menu-btn`.
 *  4. Non-interference when focus is already outside `aside.chatora-sidebar` (e.g. composer textarea
 *     or header toggle button), plus safe `.blur()` fallback when no external target is focusable.
 */

process.env.TESTING = 'true';

import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockStorage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => (mockStorage.has(key) ? mockStorage.get(key)! : null),
  setItem: (key: string, val: string) => mockStorage.set(key, String(val)),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
  get length() {
    return mockStorage.size;
  },
  key: (index: number) => Array.from(mockStorage.keys())[index] ?? null
};

(globalThis as any).window = {
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: (globalThis as any).localStorage,
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
};

Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
  writable: true
});

import { AuthProvider } from '../src/context/AuthContext.jsx';
import { SettingsProvider } from '../src/context/SettingsContext.jsx';
import Sidebar from '../src/components/layout/Sidebar.jsx';
import Header from '../src/components/layout/Header.jsx';
import Layout from '../src/components/layout/Layout.jsx';
import {
  isElementVisibleAndFocusable,
  resolveExternalSidebarFocusTarget,
  evacuateSidebarFocus
} from '../src/utils/sidebarFocusManager.js';

interface MockStyle {
  display: string;
  visibility: string;
}

class MockElement {
  nodeType = 1;
  tagName: string;
  className: string;
  disabled = false;
  inert = false;
  parentElement: MockElement | null = null;
  children: MockElement[] = [];
  style: MockStyle = { display: 'block', visibility: 'visible' };
  private attributes = new Map<string, string>();
  private ownerDoc: MockDocument;
  onAriaHiddenBlocked?: (focusedDescendant: MockElement) => void;

  constructor(tagName: string, className: string, ownerDoc: MockDocument) {
    this.tagName = tagName.toUpperCase();
    this.className = className;
    this.ownerDoc = ownerDoc;
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(target: MockElement | null | undefined): boolean {
    if (!target) return false;
    let curr: MockElement | null = target;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement;
    }
    return false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }

  setAttribute(name: string, value: string): void {
    const strVal = String(value);
    if (name === 'aria-hidden' && strVal === 'true') {
      const active = this.ownerDoc.activeElement;
      if (active && this.contains(active)) {
        if (this.onAriaHiddenBlocked) {
          this.onAriaHiddenBlocked(active);
        }
        throw new Error(
          `Blocked aria-hidden on <${this.tagName.toLowerCase()}.${this.className}> because its descendant <${active.tagName.toLowerCase()}.${active.className}> retained focus.`
        );
      }
    }
    this.attributes.set(name, strVal);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  focus(_opts?: { preventScroll?: boolean }): void {
    if (this.disabled || this.inert) return;
    this.ownerDoc.activeElement = this;
  }

  blur(): void {
    if (this.ownerDoc.activeElement === this) {
      this.ownerDoc.activeElement = this.ownerDoc.body;
    }
  }
}

class MockDocument {
  body: MockElement;
  activeElement: MockElement | null;

  constructor() {
    this.body = new MockElement('body', '', this);
    this.activeElement = this.body;
  }
}

function createLayoutDomFixture(viewportWidth: number) {
  const doc = new MockDocument();
  const isMobile = viewportWidth < 768;

  const appRoot = doc.body.appendChild(new MockElement('div', 'chatora-app', doc));

  // <aside class="chatora-sidebar"> ... <button class="btn btn-ghost btn-icon sidebar-collapse-btn">
  const aside = appRoot.appendChild(new MockElement('aside', 'chatora-sidebar', doc));
  const sidebarHeader = aside.appendChild(new MockElement('div', 'sidebar-header', doc));
  const collapseBtn = sidebarHeader.appendChild(
    new MockElement('button', 'btn btn-ghost btn-icon sidebar-collapse-btn', doc)
  );
  collapseBtn.style = { display: 'inline-flex', visibility: 'visible' };

  const searchInput = aside.appendChild(new MockElement('input', 'sidebar-search-input', doc));
  const chatItem = aside.appendChild(new MockElement('div', 'recent-chat-item-container', doc));
  const settingsBtn = aside.appendChild(
    new MockElement('button', 'sidebar-logout-btn sidebar-settings-trigger', doc)
  );

  // <div class="chatora-main"><header class="chatora-header-wrapper">...
  const main = appRoot.appendChild(new MockElement('div', 'chatora-main', doc));
  const header = main.appendChild(new MockElement('header', 'chatora-header-wrapper', doc));

  const desktopHeaderView = header.appendChild(
    new MockElement('div', 'header-desktop-view', doc)
  );
  desktopHeaderView.style = {
    display: isMobile ? 'none' : 'flex',
    visibility: 'visible'
  };
  const desktopToggleBtn = desktopHeaderView.appendChild(
    new MockElement('button', 'btn btn-ghost btn-icon desktop-sidebar-toggle-btn', doc)
  );
  desktopToggleBtn.style = { display: 'inline-flex', visibility: 'visible' };

  const mobileHeaderView = header.appendChild(
    new MockElement('div', 'header-mobile-view', doc)
  );
  mobileHeaderView.style = {
    display: isMobile ? 'flex' : 'none',
    visibility: 'visible'
  };
  const mobileToggleBtn = mobileHeaderView.appendChild(
    new MockElement('button', 'mobile-header-btn mobile-menu-btn', doc)
  );
  mobileToggleBtn.style = { display: 'flex', visibility: 'visible' };

  const composerTextarea = main.appendChild(
    new MockElement('textarea', 'composer-textarea', doc)
  );
  composerTextarea.style = { display: 'block', visibility: 'visible' };

  const win = {
    innerWidth: viewportWidth,
    getComputedStyle: (el: MockElement) => el.style
  } as unknown as Window;

  return {
    doc,
    win,
    aside,
    collapseBtn,
    searchInput,
    chatItem,
    settingsBtn,
    desktopHeaderView,
    desktopToggleBtn,
    mobileHeaderView,
    mobileToggleBtn,
    composerTextarea
  };
}

function renderWithProviders(element: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(
      AuthProvider,
      null,
      React.createElement(SettingsProvider, null, element)
    )
  );
}

console.log('--- Starting Orvix Sidebar Accessibility & Focus Regression Tests ---');

let passed = 0;
function runTest(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 1. Rendered Markup & ARIA Structure Tests
// ---------------------------------------------------------------------------
runTest('Expanded Sidebar renders id="orvix-sidebar" without aria-hidden or inert', () => {
  const html = renderWithProviders(
    React.createElement(Sidebar, {
      isOpen: true,
      onClose: () => {},
      onNewChat: () => {}
    })
  );

  assert.ok(html.includes('id="orvix-sidebar"'), 'Sidebar <aside> must have id="orvix-sidebar"');
  assert.ok(
    html.includes('class="chatora-sidebar "') || html.includes('class="chatora-sidebar"'),
    'Expanded sidebar should not have collapsed class'
  );
  assert.ok(
    !html.includes('<aside id="orvix-sidebar" class="chatora-sidebar" aria-label="Sidebar navigation" aria-hidden="true"'),
    'Expanded sidebar must NOT have aria-hidden="true"'
  );
  assert.ok(!html.includes('inert=""'), 'Expanded sidebar must NOT have inert attribute');
  assert.ok(html.includes('sidebar-collapse-btn'), 'Sidebar collapse button must render');
});

runTest('Collapsed Sidebar renders aria-hidden="true" and inert while Header expand toggles remain outside <aside>', () => {
  (globalThis as any).window.innerWidth = 390; // Mobile defaults Layout to sidebarOpen = false
  const html = renderWithProviders(
    React.createElement(Layout, {
      onNewChat: () => {},
      children: React.createElement('div', { className: 'chat-slot' }, 'Chat Body')
    })
  );

  // Verify collapsed <aside> carries aria-hidden="true" and inert
  const asideMatch = html.match(/<aside[^>]*>/);
  assert.ok(asideMatch, 'Layout must render <aside>');
  const asideTag = asideMatch![0];
  assert.ok(asideTag.includes('id="orvix-sidebar"'), 'Collapsed <aside> has id="orvix-sidebar"');
  assert.ok(asideTag.includes('collapsed'), 'Collapsed <aside> has collapsed class');
  assert.ok(asideTag.includes('aria-hidden="true"'), 'Collapsed <aside> has aria-hidden="true"');
  assert.ok(asideTag.includes('inert'), 'Collapsed <aside> has inert attribute');

  // Verify visible expand controls live inside <header>, completely outside </aside>
  const asideCloseIndex = html.indexOf('</aside>');
  const desktopToggleIndex = html.indexOf('desktop-sidebar-toggle-btn');
  const mobileToggleIndex = html.indexOf('mobile-menu-btn');

  assert.ok(asideCloseIndex > 0, '</aside> closing tag found');
  assert.ok(
    desktopToggleIndex > asideCloseIndex,
    'Desktop expand/collapse toggle button must be outside <aside> so it is never hidden by aria-hidden/inert'
  );
  assert.ok(
    mobileToggleIndex > asideCloseIndex,
    'Mobile menu button must be outside <aside> so it is never hidden by aria-hidden/inert'
  );

  // Verify Header ARIA linkage
  const headerDisabledHtml = renderWithProviders(
    React.createElement(Header, {
      sidebarOpen: false,
      onToggleSidebar: () => {},
      onNewChat: () => {}
    })
  );
  assert.ok(
    headerDisabledHtml.includes('aria-controls="orvix-sidebar"'),
    'Header toggle buttons reference aria-controls="orvix-sidebar"'
  );
  assert.ok(
    headerDisabledHtml.includes('aria-expanded="false"'),
    'Header toggle buttons expose aria-expanded="false" when collapsed'
  );

  const headerExpandedHtml = renderWithProviders(
    React.createElement(Header, {
      sidebarOpen: true,
      onToggleSidebar: () => {},
      onNewChat: () => {}
    })
  );
  assert.ok(
    headerExpandedHtml.includes('aria-expanded="true"'),
    'Header toggle buttons expose aria-expanded="true" when open'
  );
});

// ---------------------------------------------------------------------------
// 2. Reproduction & Prevention of "Blocked aria-hidden" Warning (Desktop)
// ---------------------------------------------------------------------------
runTest('Strict aria-hidden guard catches un-evacuated focus (confirms test harness reproduces the exact browser warning)', () => {
  const { aside, collapseBtn, doc } = createLayoutDomFixture(1280);
  collapseBtn.focus();
  assert.strictEqual(doc.activeElement, collapseBtn);

  assert.throws(
    () => {
      aside.setAttribute('aria-hidden', 'true');
    },
    /Blocked aria-hidden on <aside\.chatora-sidebar> because its descendant <button\.btn btn-ghost btn-icon sidebar-collapse-btn> retained focus/
  );
});

runTest('Desktop collapse from focused .sidebar-collapse-btn moves focus to .desktop-sidebar-toggle-btn BEFORE aria-hidden="true"', () => {
  const {
    doc,
    win,
    aside,
    collapseBtn,
    desktopToggleBtn,
    mobileToggleBtn,
    composerTextarea
  } = createLayoutDomFixture(1280);

  // User focuses and activates .sidebar-collapse-btn (via mouse click or keyboard Enter/Space)
  collapseBtn.focus();
  assert.strictEqual(doc.activeElement, collapseBtn);
  assert.strictEqual(aside.contains(doc.activeElement), true);

  // Execute Layout.closeSidebar() focus evacuation step BEFORE committing aria-hidden="true" + inert
  const result = evacuateSidebarFocus({
    sidebarEl: aside,
    desktopToggleEl: desktopToggleBtn,
    mobileToggleEl: mobileToggleBtn,
    fallbackEl: composerTextarea,
    doc: doc as unknown as Document,
    win
  });

  // React commits collapsed attributes on <aside>
  aside.className = 'chatora-sidebar collapsed';
  aside.setAttribute('aria-hidden', 'true'); // Would throw if focus were still inside <aside>!
  aside.inert = true;

  assert.strictEqual(result.moved, true);
  assert.strictEqual(result.target, desktopToggleBtn);
  assert.strictEqual(doc.activeElement, desktopToggleBtn);
  assert.strictEqual(aside.contains(doc.activeElement), false);
});

// ---------------------------------------------------------------------------
// 3. Mobile Drawer Focus Evacuation Across All Close Paths
// ---------------------------------------------------------------------------
runTest('Mobile close from .sidebar-collapse-btn, search input, chat item, or settings button moves focus to .mobile-menu-btn BEFORE aria-hidden="true"', () => {
  const {
    doc,
    win,
    aside,
    collapseBtn,
    searchInput,
    chatItem,
    settingsBtn,
    desktopToggleBtn,
    mobileToggleBtn,
    composerTextarea
  } = createLayoutDomFixture(390);

  for (const focusedInsideSidebar of [collapseBtn, searchInput, chatItem, settingsBtn]) {
    aside.removeAttribute('aria-hidden');
    aside.inert = false;
    aside.className = 'chatora-sidebar';

    focusedInsideSidebar.focus();
    assert.strictEqual(doc.activeElement, focusedInsideSidebar);

    const result = evacuateSidebarFocus({
      sidebarEl: aside,
      desktopToggleEl: desktopToggleBtn, // parent .header-desktop-view has display: none!
      mobileToggleEl: mobileToggleBtn,   // parent .header-mobile-view has display: flex!
      fallbackEl: composerTextarea,
      doc: doc as unknown as Document,
      win
    });

    aside.className = 'chatora-sidebar collapsed';
    aside.setAttribute('aria-hidden', 'true'); // Must never throw!
    aside.inert = true;

    assert.strictEqual(result.moved, true);
    assert.strictEqual(
      result.target,
      mobileToggleBtn,
      'Mobile drawer close must skip hidden desktop toggle and focus visible .mobile-menu-btn'
    );
    assert.strictEqual(doc.activeElement, mobileToggleBtn);
    assert.strictEqual(aside.contains(doc.activeElement), false);
  }
});

// ---------------------------------------------------------------------------
// 4. Visibility & Ancestor Inspection Edge Cases
// ---------------------------------------------------------------------------
runTest('isElementVisibleAndFocusable rejects elements with display:none, visibility:hidden, aria-hidden="true", or inert on any ancestor', () => {
  const {
    win,
    aside,
    collapseBtn,
    desktopHeaderView,
    desktopToggleBtn,
    mobileToggleBtn
  } = createLayoutDomFixture(1280);

  // Desktop default: desktopToggleBtn visible, mobileToggleBtn hidden via parent display:none
  assert.strictEqual(isElementVisibleAndFocusable(desktopToggleBtn, win), true);
  assert.strictEqual(isElementVisibleAndFocusable(mobileToggleBtn, win), false);

  // If ancestor gets aria-hidden="true", descendant is no longer a valid focus target
  aside.setAttribute('aria-hidden', 'true');
  assert.strictEqual(isElementVisibleAndFocusable(collapseBtn, win), false);
  aside.removeAttribute('aria-hidden');

  // If ancestor gets inert, descendant is no longer a valid focus target
  aside.inert = true;
  assert.strictEqual(isElementVisibleAndFocusable(collapseBtn, win), false);
  aside.inert = false;

  // Fractional zoom / CSS override where innerWidth=768 but desktop header has display:none and mobile header has display:flex
  desktopHeaderView.style.display = 'none';
  mobileToggleBtn.parentElement!.style.display = 'flex';
  const resolved = resolveExternalSidebarFocusTarget({
    desktopToggleEl: desktopToggleBtn,
    mobileToggleEl: mobileToggleBtn,
    viewportWidth: 768,
    win
  });
  assert.strictEqual(
    resolved,
    mobileToggleBtn,
    'Should automatically fall back to mobileToggleBtn when desktopHeaderView has display:none'
  );
});

// ---------------------------------------------------------------------------
// 5. Non-Interference & Standalone Blur Fallback
// ---------------------------------------------------------------------------
runTest('Collapsing sidebar does NOT steal focus when focus is already outside the sidebar', () => {
  const {
    doc,
    win,
    aside,
    desktopToggleBtn,
    mobileToggleBtn,
    composerTextarea
  } = createLayoutDomFixture(1280);

  // Case A: User is focused in composer textarea (e.g. window resized < 768px while typing)
  composerTextarea.focus();
  const resA = evacuateSidebarFocus({
    sidebarEl: aside,
    desktopToggleEl: desktopToggleBtn,
    mobileToggleEl: mobileToggleBtn,
    doc: doc as unknown as Document,
    win
  });
  aside.setAttribute('aria-hidden', 'true');
  assert.strictEqual(resA.moved, false);
  assert.strictEqual(doc.activeElement, composerTextarea);

  // Case B: User clicked the Header desktop toggle button directly
  aside.removeAttribute('aria-hidden');
  desktopToggleBtn.focus();
  const resB = evacuateSidebarFocus({
    sidebarEl: aside,
    desktopToggleEl: desktopToggleBtn,
    mobileToggleEl: mobileToggleBtn,
    doc: doc as unknown as Document,
    win
  });
  aside.setAttribute('aria-hidden', 'true');
  assert.strictEqual(resB.moved, false);
  assert.strictEqual(doc.activeElement, desktopToggleBtn);
});

runTest('Standalone Sidebar without external toggle targets safely blurs focused descendant before aria-hidden="true"', () => {
  const { doc, win, aside, collapseBtn } = createLayoutDomFixture(1280);
  collapseBtn.focus();
  assert.strictEqual(doc.activeElement, collapseBtn);

  const res = evacuateSidebarFocus({
    sidebarEl: aside,
    desktopToggleEl: null,
    mobileToggleEl: null,
    fallbackEl: null,
    doc: doc as unknown as Document,
    win
  });

  // Must not throw when setting aria-hidden="true"!
  aside.setAttribute('aria-hidden', 'true');
  assert.strictEqual(res.moved, true);
  assert.strictEqual(aside.contains(doc.activeElement), false);
  assert.strictEqual(doc.activeElement, doc.body);
});

console.log(`\n✅ All ${passed} Sidebar Accessibility & Focus Regression Tests Passed!`);
