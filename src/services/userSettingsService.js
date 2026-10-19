/**
 * Orvix User Settings Service
 * Manages personal preferences persistence:
 * - Signed-in users: Persisted to Cloud Firestore under /users/{userId}/settings/preferences, cached locally in user-scoped storage
 * - Guest explorers: Persisted strictly to local storage
 * - Restores default settings if missing or corrupt
 * - Isolates preferences between different user accounts
 */

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../config/firebaseConfig.js';

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
 * Enforces per-user data isolation.
 *
 * @param {string|null} userId
 * @returns {string}
 */
function getStorageKey(userId) {
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

/**
 * Loads preferences for the given user ID (or guest).
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

  // 2. For registered users with Firebase active, attempt cloud retrieval
  if (isRegisteredUser && isFirebaseConfigured() && db) {
    try {
      const settingsRef = doc(db, 'users', userId, 'settings', 'preferences');
      const snap = await getDoc(settingsRef);

      if (snap.exists()) {
        const cloudData = snap.data();
        const sanitized = sanitizeSettings(cloudData);

        // Update local cache
        try {
          if (typeof window !== 'undefined') {
            localStorage.setItem(storageKey, JSON.stringify(sanitized));
          }
        } catch (_) {}

        return sanitized;
      }
    } catch (cloudErr) {
      console.warn('Could not fetch settings from Firestore, falling back to local cache:', cloudErr);
    }
  }

  // Return locally cached settings if available, else defaults
  return localSettings || { ...DEFAULT_SETTINGS };
}

/**
 * Saves preferences for the given user ID (or guest).
 *
 * @param {string|null} userId
 * @param {Partial<typeof DEFAULT_SETTINGS>} partialSettings
 * @param {typeof DEFAULT_SETTINGS} [currentSettings]
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function saveSettings(userId = null, partialSettings, currentSettings = DEFAULT_SETTINGS) {
  const merged = {
    ...currentSettings,
    ...partialSettings
  };
  const sanitized = sanitizeSettings(merged);
  const storageKey = getStorageKey(userId);
  const isRegisteredUser = Boolean(userId && !userId.startsWith('guest-'));

  // 1. Always update local storage first
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(storageKey, JSON.stringify(sanitized));
    }
  } catch (localErr) {
    console.warn('Could not save settings locally:', localErr);
  }

  // 2. Persist to Firestore for registered users if configured
  if (isRegisteredUser && isFirebaseConfigured() && db) {
    try {
      const settingsRef = doc(db, 'users', userId, 'settings', 'preferences');
      await setDoc(
        settingsRef,
        {
          ...sanitized,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (cloudErr) {
      console.warn('Could not save settings to Firestore, saved locally:', cloudErr);
    }
  }

  return sanitized;
}
