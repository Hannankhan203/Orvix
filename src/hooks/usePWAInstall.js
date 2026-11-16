import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

const PWAInstallContext = createContext(null);

const consumedPromptEvents = new WeakSet();
const windowStores = new WeakMap();
let fallbackStore = null;

function detectStandalone(win) {
  if (!win) return false;
  try {
    const mediaMatches = Boolean(win.matchMedia?.('(display-mode: standalone)')?.matches);
    const iosStandalone = win.navigator?.standalone === true;
    return mediaMatches || iosStandalone;
  } catch (_) {
    return false;
  }
}

function detectIOS(win) {
  if (!win?.navigator?.userAgent) return false;
  try {
    const userAgent = String(win.navigator.userAgent).toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  } catch (_) {
    return false;
  }
}

function createPWAInstallStore(win) {
  let state = {
    deferredPrompt: null,
    isInstalled: detectStandalone(win),
    isIOS: detectIOS(win),
    isInstalling: false
  };

  const listeners = new Set();
  let windowListenersAttached = false;

  const notify = () => {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (_) {}
    });
  };

  const setState = (updater) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    const nextState = { ...state, ...patch };
    if (
      nextState.deferredPrompt === state.deferredPrompt &&
      nextState.isInstalled === state.isInstalled &&
      nextState.isIOS === state.isIOS &&
      nextState.isInstalling === state.isInstalling
    ) {
      return;
    }
    state = nextState;
    notify();
  };

  const attachWindowListeners = () => {
    if (!win || windowListenersAttached) return;
    windowListenersAttached = true;

    const handleBeforeInstallPrompt = (e) => {
      if (!e || consumedPromptEvents.has(e)) return;
      if (typeof e.preventDefault === 'function') {
        e.preventDefault();
      }
      setState({
        deferredPrompt: e,
        isInstalled: detectStandalone(win)
      });
    };

    const handleAppInstalled = () => {
      setState({
        isInstalled: true,
        deferredPrompt: null,
        isInstalling: false
      });
    };

    const standaloneMedia = win.matchMedia?.('(display-mode: standalone)');
    const handleDisplayModeChange = (e) => {
      if (e?.matches) {
        setState({
          isInstalled: true,
          deferredPrompt: null,
          isInstalling: false
        });
      }
    };

    win.addEventListener?.('beforeinstallprompt', handleBeforeInstallPrompt);
    win.addEventListener?.('appinstalled', handleAppInstalled);
    if (standaloneMedia?.addEventListener) {
      standaloneMedia.addEventListener('change', handleDisplayModeChange);
    } else if (standaloneMedia?.addListener) {
      standaloneMedia.addListener(handleDisplayModeChange);
    }
  };

  attachWindowListeners();

  const subscribe = (listener) => {
    attachWindowListeners();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => state;

  const install = async () => {
    const promptEvent = state.deferredPrompt;
    if (
      !promptEvent ||
      state.isInstalled ||
      state.isInstalling ||
      consumedPromptEvents.has(promptEvent)
    ) {
      return false;
    }

    consumedPromptEvents.add(promptEvent);
    setState({ isInstalling: true });

    let accepted = false;
    try {
      await Promise.resolve(promptEvent.prompt());
      const choice = await Promise.resolve(promptEvent.userChoice);
      accepted = choice?.outcome === 'accepted';
    } catch (err) {
      console.warn('PWA install prompt failed or was rejected:', err);
      accepted = false;
    } finally {
      setState((prev) => ({
        deferredPrompt: prev.deferredPrompt === promptEvent ? null : prev.deferredPrompt,
        isInstalled: accepted ? true : prev.isInstalled,
        isInstalling: false
      }));
    }

    return accepted;
  };

  const refreshEnvironment = () => {
    setState({
      isInstalled: state.isInstalled || detectStandalone(win),
      isIOS: detectIOS(win)
    });
  };

  return {
    subscribe,
    getSnapshot,
    install,
    refreshEnvironment
  };
}

function getStoreForCurrentWindow() {
  if (typeof window === 'undefined') {
    if (!fallbackStore) {
      fallbackStore = createPWAInstallStore(null);
    }
    return fallbackStore;
  }

  let store = windowStores.get(window);
  if (!store) {
    store = createPWAInstallStore(window);
    windowStores.set(window, store);
  }
  return store;
}

/**
 * Optional provider to explicitly scope/share PWA install state via React Context.
 * Even without a provider, usePWAInstall synchronizes across all mounted components
 * sharing the same window (e.g. Header and Sidebar).
 */
export function PWAInstallProvider({ children }) {
  const store = getStoreForCurrentWindow();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    store.refreshEnvironment();
  }, [store]);

  const value = {
    isInstallable: Boolean(state.deferredPrompt) && !state.isInstalled,
    isInstalled: state.isInstalled,
    isIOS: state.isIOS,
    isInstalling: state.isInstalling,
    install: store.install
  };

  return React.createElement(PWAInstallContext.Provider, { value }, children);
}

/**
 * Custom hook to manage synchronized PWA installation state and triggers.
 * Handles BeforeInstallPromptEvent on Chromium browsers, prevents duplicate
 * calls to consumed prompts, clears prompts on both acceptance and dismissal,
 * detects standalone mode, and supports iOS Safari fallback guidance.
 */
export function usePWAInstall() {
  const ctx = useContext(PWAInstallContext);
  const store = getStoreForCurrentWindow();
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (ctx) return undefined;
    store.refreshEnvironment();
    return store.subscribe(() => {
      setVersion((v) => v + 1);
    });
  }, [ctx, store]);

  if (ctx) {
    return ctx;
  }

  const state = store.getSnapshot();
  return {
    isInstallable: Boolean(state.deferredPrompt) && !state.isInstalled,
    isInstalled: state.isInstalled,
    isIOS: state.isIOS,
    isInstalling: state.isInstalling,
    install: store.install
  };
}
