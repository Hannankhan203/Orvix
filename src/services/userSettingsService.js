/**
 * Orvix User Settings Service
 * Manages personal preferences persistence:
 * - Registered users: Persisted to MongoDB Atlas via authenticated Express API (/api/user-settings/me)
 *   and cached in user-scoped local storage for instant render and offline continuity
 * - Guest explorers: Persisted strictly to local storage without requiring authentication or MongoDB
 * - Restores default settings if missing, partial, or corrupted
 * - Strict per-user isolation: identity derived exclusively from verified backend token
 *
 * Phase 3, Step 3.2: Migrated from direct Cloud Firestore access to authenticated Express/MongoDB API.
 */

import { auth, isBrowserOnline } from '../config/firebaseConfig.js';
import { getIdToken } from './authService.js';

export const DEFAULT_SETTINGS = {
  theme: 'system', // 'light' | 'dark' | 'system'
  responseLength: 'balanced', // 'concise' | 'balanced' | 'detailed'
  defaultMode: 'general', // 'general' | 'coding' | 'writing' | 'learning'
  beginnerFriendly: false, // boolean
  enterToSend: true, // boolean
  showTimestamps: true, // boolean
  speechRate: 1, // 0.75 | 1 | 1.25 | 1.5 | 2
  speechVoiceURI: '' // string (empty for browser default)
};

export const THEME_OPTIONS = [
  { id: 'system', label: 'System', description: 'Matches device color scheme' },
  { id: 'dark', label: 'Dark', description: 'Obsidian dark appearance' },
  { id: 'light', label: 'Light', description: 'Crisp, high-contrast light appearance' }
];

export const RESPONSE_LENGTH_OPTIONS = [
  { id: 'concise', label: 'Concise', description: 'Compact and focused without fluff' },
  { id: 'balanced', label: 'Balanced', description: 'Optimal blend of detail and clarity' },
  { id: 'detailed', label: 'Detailed', description: 'Thorough, in-depth explanations with context' }
];

export const CHAT_MODE_PREFERENCE_OPTIONS = [
  { id: 'general', label: 'General Assistant', description: 'Versatile companion for everyday questions' },
  { id: 'coding', label: 'Coding', description: 'Programming, debugging & technical guidance' },
  { id: 'writing', label: 'Writing', description: 'Drafting, editing & tone polishing' },
  { id: 'learning', label: 'Learning', description: 'Concept breakdown with step-by-step analogies' }
];

const VALID_THEMES = new Set(['system', 'dark', 'light']);
const VALID_RESPONSE_LENGTHS = new Set(['concise', 'balanced', 'detailed']);
const VALID_MODES = new Set(['general', 'coding', 'writing', 'learning']);

/**
 * Sanitizes and validates settings against allowed options.
 * Restores defaults if values are missing, invalid, or corrupted.
 *
 * @param {any} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }

  const theme = VALID_THEMES.has(raw.theme) ? raw.theme : DEFAULT_SETTINGS.theme;
  const responseLength = VALID_RESPONSE_LENGTHS.has(raw.responseLength)
    ? raw.responseLength
    : DEFAULT_SETTINGS.responseLength;

  const defaultMode = VALID_MODES.has(raw.defaultMode)
    ? raw.defaultMode
    : DEFAULT_SETTINGS.defaultMode;

  const beginnerFriendly =
    typeof raw.beginnerFriendly === 'boolean'
      ? raw.beginnerFriendly
      : DEFAULT_SETTINGS.beginnerFriendly;

  const enterToSend =
    typeof raw.enterToSend === 'boolean'
      ? raw.enterToSend
      : DEFAULT_SETTINGS.enterToSend;

  const showTimestamps =
    typeof raw.showTimestamps === 'boolean'
      ? raw.showTimestamps
      : DEFAULT_SETTINGS.showTimestamps;

  const rawRate = parseFloat(raw.speechRate);
  const speechRate =
    !isNaN(rawRate) && rawRate >= 0.5 && rawRate <= 2.5
      ? rawRate
      : DEFAULT_SETTINGS.speechRate;

  const speechVoiceURI =
    typeof raw.speechVoiceURI === 'string'
      ? raw.speechVoiceURI
      : DEFAULT_SETTINGS.speechVoiceURI;

  return {
    theme,
    responseLength,
    defaultMode,
    beginnerFriendly,
    enterToSend,
    showTimestamps,
    speechRate,
    speechVoiceURI
  };
}

/**
 * Helper to get the local storage key for a user or guest.
 * Enforces per-user data isolation in local storage.
 *
 * @param {string|null} userId
 * @returns {string}
 */
export function getStorageKey(userId) {
  if (userId && !userId.startsWith('guest-')) {
    return `orvix_user_settings_${userId}`;
  }
  return 'orvix_guest_settings';
}

/**
 * Resolves whether the current active theme is 'light' or 'dark',
 * taking into account system preference when theme is 'system'.
 *
 * @param {string} theme
 * @returns {'light' | 'dark'}
 */
export function resolveEffectiveTheme(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';

  if (typeof window !== 'undefined' && window.matchMedia) {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {}
  }

  return 'dark';
}

export {
  setAuthTokenProviderForTesting,
  resolveAuthToken,
  getApiEndpoint,
  authorizedApiFetch
} from './mongoApiClient.js';
import {
  setAuthTokenProviderForTesting,
  resolveAuthToken,
  getApiEndpoint,
  authorizedApiFetch
} from './mongoApiClient.js';

/**
 * Loads preferences for the given user ID (or guest).
 * Checks local cache first for instant synchronous render, then syncs with MongoDB if online.
 *
 * @param {string|null} userId
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function loadSettings(userId = null) {
  const isRegisteredUser = Boolean(userId && !userId.startsWith('guest-'));
  const storageKey = getStorageKey(userId);

  // 1. Check local cache first for instant synchronous render
  let localSettings = null;
  try {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        localSettings = sanitizeSettings(JSON.parse(stored));
      }
    }
  } catch (err) {
    console.warn('Could not read settings from local storage:', err);
  }

  // 2. For registered users who are online, fetch from authenticated MongoDB API (/api/user-settings/me)
  if (isRegisteredUser && isBrowserOnline()) {
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer = null;
      if (controller) {
        timer = setTimeout(() => controller.abort(), 4000);
      }

      const { res: response } = await authorizedApiFetch(
        '/api/user-settings/me',
        {
          method: 'GET',
          signal: controller ? controller.signal : undefined
        }
      ).finally(() => {
        if (timer) clearTimeout(timer);
      });

      if (response) {
        if (response.ok) {
          const data = await response.json();
          if (data?.settings) {
            const sanitized = sanitizeSettings(data.settings);

            // Update local cache for offline continuity and instant future render
            try {
              if (typeof window !== 'undefined') {
                localStorage.setItem(storageKey, JSON.stringify(sanitized));
              }
            } catch (_) {}

            return sanitized;
          }
        } else if (response.status === 404) {
          // No settings document in database yet; fallback to local settings or defaults
          return localSettings || { ...DEFAULT_SETTINGS };
        } else {
          console.warn(`[UserSettingsService] Settings fetch returned HTTP ${response.status}`);
        }
      }
    } catch (err) {
      console.warn('Could not fetch settings from MongoDB API, using local cache:', err?.message || err);
    }
  }

  // Return locally cached settings if available, else defaults
  return localSettings || { ...DEFAULT_SETTINGS };
}

/**
 * Saves preferences for the given user ID (or guest).
 * Immediately updates local storage, then persists to MongoDB Atlas via Express API (/api/user-settings/me).
 *
 * @param {string|null} userId
 * @param {Partial<typeof DEFAULT_SETTINGS>} partialSettings
 * @param {typeof DEFAULT_SETTINGS} [currentSettings=DEFAULT_SETTINGS]
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function saveSettings(userId = null, partialSettings = {}, currentSettings = DEFAULT_SETTINGS) {
  const storageKey = getStorageKey(userId);
  const isRegisteredUser = Boolean(userId && !userId.startsWith('guest-'));

  // If currentSettings was not explicitly customized by caller, inspect local cache first
  // to ensure partial updates do not accidentally reset other previously saved fields
  let baseSettings = currentSettings;
  if (baseSettings === DEFAULT_SETTINGS) {
    try {
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          baseSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
        }
      }
    } catch (_) {}
  }

  const merged = {
    ...baseSettings,
    ...partialSettings
  };
  const sanitized = sanitizeSettings(merged);

  // 1. Immediately update local storage for instantaneous UI response & offline persistence
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(storageKey, JSON.stringify(sanitized));
    }
  } catch (localErr) {
    console.warn('Could not save settings locally:', localErr);
  }

  // 2. Guest explorers: persist strictly to local storage without server requests
  if (!isRegisteredUser) {
    return sanitized;
  }

  // 3. Offline mode: local cache updated, defer server write without crashing
  if (!isBrowserOnline()) {
    return sanitized;
  }

  // 5. Persist to MongoDB via Express API (POST /api/user-settings/me)
  // Identity is derived exclusively from the verified token on the server
  try {
    const { res: response, token } = await authorizedApiFetch(
      '/api/user-settings/me',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sanitized)
      }
    );

    if (!token || !response) {
      // If not yet authenticated with token, settings remain safely stored locally
      return sanitized;
    }

    if (response.ok) {
      const data = await response.json();
      if (data?.settings) {
        const serverSanitized = sanitizeSettings(data.settings);
        try {
          if (typeof window !== 'undefined') {
            localStorage.setItem(storageKey, JSON.stringify(serverSanitized));
          }
        } catch (_) {}
        return serverSanitized;
      }
    } else {
      let errMsg = '';
      try {
        const errJson = await response.json();
        errMsg = errJson?.error || `HTTP ${response.status}`;
      } catch (_) {
        errMsg = `HTTP ${response.status}`;
      }

      if (response.status === 401 || response.status === 403) {
        console.warn(`[UserSettingsService] Authentication error while saving settings (HTTP ${response.status}): ${errMsg}`);
      } else {
        console.warn(`[UserSettingsService] Could not persist settings to MongoDB (HTTP ${response.status}): ${errMsg}`);
      }
    }
  } catch (cloudErr) {
    console.warn('Could not save settings to MongoDB API, saved locally:', cloudErr?.message || cloudErr);
  }

  return sanitized;
}
