import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from './AuthContext.jsx';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  sanitizeSettings,
  getSettingsStorageKey,
  resolveEffectiveTheme
} from '../services/userSettingsService.js';

const SettingsContext = createContext(null);

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}

export function useOptionalSettings() {
  return useContext(SettingsContext);
}

function readCachedSettingsSync(uid) {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const key = getSettingsStorageKey(uid);
      const cached = localStorage.getItem(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object') {
          return sanitizeSettings(parsed);
        }
      }
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

export function SettingsProvider({ children, settingsDeps = null }) {
  const { currentUser } = useAuth();
  const userId = currentUser?.uid || null;

  const depsRef = useRef(null);
  depsRef.current = {
    loadSettings,
    saveSettings,
    ...settingsDeps
  };

  // Track ownerUserId alongside data so account switches never expose a prior user's settings even for one render
  const [settingsState, setSettingsState] = useState(() => ({
    ownerUserId: userId,
    data: readCachedSettingsSync(userId)
  }));

  const settings =
    settingsState.ownerUserId === userId
      ? settingsState.data
      : readCachedSettingsSync(userId);

  const settingsRef = useRef(settings);
  const settingsOwnerRef = useRef(userId);
  if (settingsOwnerRef.current !== userId) {
    settingsRef.current = settings;
    settingsOwnerRef.current = userId;
  }

  const activeUserIdRef = useRef(userId);
  activeUserIdRef.current = userId;

  const isMountedRef = useRef(true);
  const mutationSeqRef = useRef(0);
  const pendingLoadRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const pendingSaveCountRef = useRef(0);

  const [effectiveTheme, setEffectiveTheme] = useState(() => resolveEffectiveTheme(settings.theme));
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(null); // 'saved' | 'reset'
  const feedbackTimerRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, []);

  // Apply theme attributes to <html> root element
  const applyThemeToDOM = useCallback((themeName) => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    root.setAttribute('data-theme', themeName);
    if (themeName === 'light') {
      root.classList.remove('theme-dark');
      root.classList.add('theme-light');
    } else {
      root.classList.remove('theme-light');
      root.classList.add('theme-dark');
    }

    // Synchronize mobile browser chrome theme-color meta tags
    try {
      const themeColor = themeName === 'light' ? '#ffffff' : '#090d16';
      const metas = document.querySelectorAll('meta[name="theme-color"]');
      metas.forEach((m) => {
        if (!m.hasAttribute('media')) {
          m.setAttribute('content', themeColor);
        }
      });
    } catch (_) {}

    try {
      localStorage.setItem('orvix_active_theme', themeName);
    } catch (_) {}
  }, []);

  // Update effectiveTheme whenever settings.theme changes
  useEffect(() => {
    const resolved = resolveEffectiveTheme(settings.theme);
    setEffectiveTheme(resolved);
    applyThemeToDOM(resolved);
  }, [settings.theme, applyThemeToDOM]);

  // Listen to OS system color-scheme changes if theme is set to 'system'
  useEffect(() => {
    if (settings.theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = (e) => {
      const newTheme = e.matches ? 'dark' : 'light';
      setEffectiveTheme(newTheme);
      applyThemeToDOM(newTheme);
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleMediaChange);
      return () => mediaQuery.removeEventListener('change', handleMediaChange);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(handleMediaChange);
      return () => mediaQuery.removeListener(handleMediaChange);
    }
  }, [settings.theme, applyThemeToDOM]);

  // Reload settings whenever the user switches, logs in, or logs out
  useEffect(() => {
    let isCancelled = false;
    const targetUserId = userId;
    const initialCached = readCachedSettingsSync(targetUserId);

    mutationSeqRef.current += 1;
    const loadMutationSeq = mutationSeqRef.current;

    settingsRef.current = initialCached;
    settingsOwnerRef.current = targetUserId;
    setSettingsState({
      ownerUserId: targetUserId,
      data: initialCached
    });
    setSaveFeedback(null);

    const initialResolvedTheme = resolveEffectiveTheme(initialCached.theme);
    setEffectiveTheme(initialResolvedTheme);
    applyThemeToDOM(initialResolvedTheme);

    setIsSettingsLoading(true);

    const loadPromise = (async () => {
      try {
        const loaded = sanitizeSettings(await depsRef.current.loadSettings(targetUserId));
        if (
          !isCancelled &&
          isMountedRef.current &&
          activeUserIdRef.current === targetUserId &&
          mutationSeqRef.current === loadMutationSeq
        ) {
          settingsRef.current = loaded;
          settingsOwnerRef.current = targetUserId;
          setSettingsState({
            ownerUserId: targetUserId,
            data: loaded
          });
          const resolved = resolveEffectiveTheme(loaded.theme);
          setEffectiveTheme(resolved);
          applyThemeToDOM(resolved);
        }
        return settingsRef.current;
      } catch (err) {
        console.warn('Could not load user settings:', err);
        return settingsRef.current;
      } finally {
        if (pendingLoadRef.current?.promise === loadPromise) {
          pendingLoadRef.current = null;
        }
        if (!isCancelled && isMountedRef.current) {
          setIsSettingsLoading(false);
        }
      }
    })();

    pendingLoadRef.current = {
      userId: targetUserId,
      promise: loadPromise
    };

    return () => {
      isCancelled = true;
      if (pendingLoadRef.current?.promise === loadPromise) {
        pendingLoadRef.current = null;
      }
    };
  }, [userId, applyThemeToDOM]);

  const showFeedback = useCallback((type) => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setSaveFeedback(type);
    feedbackTimerRef.current = setTimeout(() => {
      feedbackTimerRef.current = null;
      if (isMountedRef.current) {
        setSaveFeedback(null);
      }
    }, 2000);
  }, []);

  const hasPendingSettingsLoad = useCallback(() => {
    const pending = pendingLoadRef.current;
    return Boolean(
      (pending && pending.userId === activeUserIdRef.current) ||
        settingsOwnerRef.current !== activeUserIdRef.current
    );
  }, []);

  const ensureSettingsLoaded = useCallback(async () => {
    const pending = pendingLoadRef.current;
    if (pending && pending.userId === activeUserIdRef.current) {
      try {
        await Promise.race([
          pending.promise,
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
      } catch (_) {}
    }
    return settingsRef.current;
  }, []);

  /**
   * Optimistically updates partial settings, serializes persistence to avoid lost updates
   * or out-of-order overwrites, and notifies feedback.
   */
  const updateSettings = useCallback(
    (partial) => {
      const targetUserId = activeUserIdRef.current;
      const prevSnapshot = settingsRef.current;
      const nextSettings = sanitizeSettings({
        ...prevSnapshot,
        ...partial
      });

      mutationSeqRef.current += 1;
      const opSeq = mutationSeqRef.current;

      settingsRef.current = nextSettings;
      settingsOwnerRef.current = targetUserId;
      setSettingsState({
        ownerUserId: targetUserId,
        data: nextSettings
      });

      pendingSaveCountRef.current += 1;
      setIsSaving(true);

      const persistTask = async () => {
        try {
          const updated = await depsRef.current.saveSettings(
            targetUserId,
            partial,
            prevSnapshot
          );
          const sanitizedUpdated = sanitizeSettings(updated);
          if (
            isMountedRef.current &&
            activeUserIdRef.current === targetUserId &&
            mutationSeqRef.current === opSeq
          ) {
            settingsRef.current = sanitizedUpdated;
            settingsOwnerRef.current = targetUserId;
            setSettingsState({
              ownerUserId: targetUserId,
              data: sanitizedUpdated
            });
          }
          if (isMountedRef.current && activeUserIdRef.current === targetUserId) {
            showFeedback('saved');
          }
          return sanitizedUpdated;
        } catch (err) {
          console.error('Failed to update settings:', err);
          throw err;
        } finally {
          pendingSaveCountRef.current = Math.max(0, pendingSaveCountRef.current - 1);
          if (isMountedRef.current) {
            setIsSaving(pendingSaveCountRef.current > 0);
          }
        }
      };

      const queuedPromise = saveQueueRef.current
        .catch(() => {})
        .then(persistTask);
      saveQueueRef.current = queuedPromise.catch(() => {});
      return queuedPromise;
    },
    [showFeedback]
  );

  /**
   * Resets all settings to default values.
   */
  const resetToDefaults = useCallback(() => {
    const targetUserId = activeUserIdRef.current;
    const defaultsCopy = { ...DEFAULT_SETTINGS };

    mutationSeqRef.current += 1;
    const opSeq = mutationSeqRef.current;

    settingsRef.current = defaultsCopy;
    settingsOwnerRef.current = targetUserId;
    setSettingsState({
      ownerUserId: targetUserId,
      data: defaultsCopy
    });

    pendingSaveCountRef.current += 1;
    setIsSaving(true);

    const resetTask = async () => {
      try {
        const reset = await depsRef.current.saveSettings(
          targetUserId,
          defaultsCopy,
          defaultsCopy
        );
        const sanitizedReset = sanitizeSettings(reset);
        if (
          isMountedRef.current &&
          activeUserIdRef.current === targetUserId &&
          mutationSeqRef.current === opSeq
        ) {
          settingsRef.current = sanitizedReset;
          settingsOwnerRef.current = targetUserId;
          setSettingsState({
            ownerUserId: targetUserId,
            data: sanitizedReset
          });
        }
        if (isMountedRef.current && activeUserIdRef.current === targetUserId) {
          showFeedback('reset');
        }
        return sanitizedReset;
      } catch (err) {
        console.error('Failed to reset settings:', err);
        throw err;
      } finally {
        pendingSaveCountRef.current = Math.max(0, pendingSaveCountRef.current - 1);
        if (isMountedRef.current) {
          setIsSaving(pendingSaveCountRef.current > 0);
        }
      }
    };

    const queuedPromise = saveQueueRef.current
      .catch(() => {})
      .then(resetTask);
    saveQueueRef.current = queuedPromise.catch(() => {});
    return queuedPromise;
  }, [showFeedback]);

  const openSettingsModal = useCallback(() => {
    setIsSettingsModalOpen(true);
  }, []);

  const closeSettingsModal = useCallback(() => {
    setIsSettingsModalOpen(false);
  }, []);

  const value = useMemo(
    () => ({
      userId,
      settings,
      effectiveTheme,
      updateSettings,
      resetToDefaults,
      isSettingsModalOpen,
      openSettingsModal,
      closeSettingsModal,
      isSettingsLoading,
      hasPendingSettingsLoad,
      ensureSettingsLoaded,
      isSaving,
      saveFeedback,
      isRegisteredUser: Boolean(userId && !userId.startsWith('guest-'))
    }),
    [
      userId,
      settings,
      effectiveTheme,
      updateSettings,
      resetToDefaults,
      isSettingsModalOpen,
      openSettingsModal,
      closeSettingsModal,
      isSettingsLoading,
      hasPendingSettingsLoad,
      ensureSettingsLoaded,
      isSaving,
      saveFeedback
    ]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
