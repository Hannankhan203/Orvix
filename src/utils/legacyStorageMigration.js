// @ts-check
/**
 * Legacy Storage Migration Utility
 * Safely migrates legacy 'chatora_*' browser storage keys to canonical 'orvix_*' keys
 * while preserving user sessions, chats, pins, and provider preferences.
 */

const LEGACY_STORAGE_KEYS = Object.freeze({
  session: Object.freeze([
    { currentKey: 'orvix_guest_session', legacyKey: 'chatora_guest_session' },
    { currentKey: 'orvix_active_chat', legacyKey: 'chatora_active_chat' }
  ]),
  local: Object.freeze([
    { currentKey: 'orvix_guest_session', legacyKey: 'chatora_guest_session' },
    { currentKey: 'orvix_selected_provider', legacyKey: 'chatora_selected_provider' },
    { currentKey: 'orvix_guest_pins', legacyKey: 'chatora_guest_pins' },
    { currentKey: 'orvix_guest_chats', legacyKey: 'chatora_guest_chats' }
  ])
});

const KEY_PAIR_BY_CURRENT = new Map(
  [...LEGACY_STORAGE_KEYS.session, ...LEGACY_STORAGE_KEYS.local].map((entry) => [
    entry.currentKey,
    entry.legacyKey
  ])
);

/**
 * @param {string} currentKey
 * @returns {string | null}
 */
function resolveLegacyKey(currentKey) {
  return KEY_PAIR_BY_CURRENT.get(currentKey) ?? null;
}

/**
 * Reads a canonical 'orvix_*' key from the provided Web Storage instance.
 * If the canonical key is absent and a legacy key exists, safely migrates
 * the value into the canonical key before returning it.
 * Never deletes the legacy key unless the canonical value is safely persisted.
 *
 * @param {Storage | null | undefined} storage
 * @param {string} currentKey
 * @returns {string | null}
 */
export function readMigratedStorageItem(storage, currentKey) {
  if (!storage || typeof storage.getItem !== 'function') {
    return null;
  }

  let currentValue = null;
  try {
    currentValue = storage.getItem(currentKey);
  } catch (_) {
    return null;
  }

  const legacyKey = resolveLegacyKey(currentKey);
  if (!legacyKey) {
    return currentValue;
  }

  if (currentValue !== null) {
    // Clean up superseded legacy key only when canonical key already has data
    try {
      if (storage.getItem(legacyKey) !== null && typeof storage.removeItem === 'function') {
        storage.removeItem(legacyKey);
      }
    } catch (_) {}
    return currentValue;
  }

  let legacyValue = null;
  try {
    legacyValue = storage.getItem(legacyKey);
  } catch (_) {
    return null;
  }

  if (legacyValue === null) {
    return null;
  }

  // Safely copy legacy value to canonical key, removing legacy key only if persistence verified
  try {
    if (typeof storage.setItem === 'function') {
      storage.setItem(currentKey, legacyValue);
      if (storage.getItem(currentKey) === legacyValue && typeof storage.removeItem === 'function') {
        storage.removeItem(legacyKey);
      }
    }
  } catch (_) {
    // Preserve legacy key untouched on QuotaExceededError or read-only storage
  }

  return legacyValue;
}

/**
 * Removes a canonical key and any mapped legacy alias from storage.
 *
 * @param {Storage | null | undefined} storage
 * @param {string} currentKey
 */
export function removeMigratedStorageItem(storage, currentKey) {
  if (!storage || typeof storage.removeItem !== 'function') {
    return;
  }

  try {
    storage.removeItem(currentKey);
  } catch (_) {}

  const legacyKey = resolveLegacyKey(currentKey);
  if (legacyKey) {
    try {
      storage.removeItem(legacyKey);
    } catch (_) {}
  }
}

/**
 * Idempotently migrates all known legacy storage keys in sessionStorage and localStorage
 * to their canonical Orvix equivalents on application startup.
 */
export function migrateLegacyStorage() {
  if (typeof sessionStorage !== 'undefined') {
    for (const { currentKey } of LEGACY_STORAGE_KEYS.session) {
      readMigratedStorageItem(sessionStorage, currentKey);
    }
  }
  if (typeof localStorage !== 'undefined') {
    for (const { currentKey } of LEGACY_STORAGE_KEYS.local) {
      readMigratedStorageItem(localStorage, currentKey);
    }
  }
}
