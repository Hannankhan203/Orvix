import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './AuthContext.jsx';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
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

export function SettingsProvider({ children }) {
  const { currentUser } = useAuth();
  const userId = currentUser?.uid || null;

  // Initialize with safe defaults, overwritten synchronously from local cache if possible
  const [settings, setSettings] = useState(() => {
    try {
      if (typeof window !== 'undefined') {
        const key = userId && !userId.startsWith('guest-')
          ? `orvix_user_settings_${userId}`
          : 'orvix_guest_settings';
        const cached = localStorage.getItem(key);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === 'object') {
            return { ...DEFAULT_SETTINGS, ...parsed };
          }
        }
      }
    } catch (_) {}
    return { ...DEFAULT_SETTINGS };
  });

  const [effectiveTheme, setEffectiveTheme] = useState(() => resolveEffectiveTheme(settings.theme));
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(null); // 'saved' | 'reset'
  const feedbackTimerRef = useRef(null);

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

    async function fetchUserSettings() {
      const loaded = await loadSettings(userId);
      if (!isCancelled) {
        setSettings(loaded);
        const resolved = resolveEffectiveTheme(loaded.theme);
        setEffectiveTheme(resolved);
        applyThemeToDOM(resolved);
      }
    }

    fetchUserSettings();

    return () => {
      isCancelled = true;
    };
  }, [userId, applyThemeToDOM]);

  const showFeedback = (type) => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setSaveFeedback(type);
    feedbackTimerRef.current = setTimeout(() => {
      setSaveFeedback(null);
    }, 2000);
  };

  /**
   * Updates partial settings, persists to storage, and notifies feedback.
   */
  const updateSettings = useCallback(
    async (partial) => {
      setIsSaving(true);
      try {
        const updated = await saveSettings(userId, partial, settings);
        setSettings(updated);
        showFeedback('saved');
        return updated;
      } catch (err) {
        console.error('Failed to update settings:', err);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [userId, settings]
  );

  /**
   * Resets all settings to default values.
   */
  const resetToDefaults = useCallback(async () => {
    setIsSaving(true);
    try {
      const reset = await saveSettings(userId, DEFAULT_SETTINGS, DEFAULT_SETTINGS);
      setSettings(reset);
      showFeedback('reset');
      return reset;
    } catch (err) {
      console.error('Failed to reset settings:', err);
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, [userId]);

  const openSettingsModal = useCallback(() => {
    setIsSettingsModalOpen(true);
  }, []);

  const closeSettingsModal = useCallback(() => {
    setIsSettingsModalOpen(false);
  }, []);

  const value = {
    settings,
    effectiveTheme,
    updateSettings,
    resetToDefaults,
    isSettingsModalOpen,
    openSettingsModal,
    closeSettingsModal,
    isSaving,
    saveFeedback,
    isRegisteredUser: Boolean(userId && !userId.startsWith('guest-'))
  };

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
