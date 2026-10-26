/**
 * Orvix User Profile Service
 * Handles user profile persistence in MongoDB Atlas via the authenticated Express API (/api/users/me),
 * username validation, local storage caching, and synchronization with Firebase Auth.
 *
 * Phase 3, Step 3.1: Migrated from direct Firestore operations to authenticated Express/MongoDB API.
 */

import { updateProfile } from 'firebase/auth';
import { auth, isBrowserOnline } from '../config/firebaseConfig.js';
import { getIdToken } from './authService.js';

function getProfileCacheKey(userId) {
  return `orvix_user_profile_${userId}`;
}

export function getCachedUserProfile(userId) {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(getProfileCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function saveCachedUserProfile(userId, profile) {
  if (!userId || !profile || typeof window === 'undefined') return;
  try {
    localStorage.setItem(getProfileCacheKey(userId), JSON.stringify(profile));
  } catch (_) {}
}

export const USERNAME_CONSTRAINTS = {
  MIN_LENGTH: 2,
  MAX_LENGTH: 30,
  // Allowed characters: letters, numbers, spaces, underscores, hyphens, and periods
  PATTERN: /^[a-zA-Z0-9_\-\. ]+$/
};

/**
 * Validates a username according to application constraints.
 * @param {string} username
 * @returns {{ isValid: boolean, error?: string, sanitized: string }}
 */
export function validateUsername(username) {
  if (typeof username !== 'string') {
    return { isValid: false, error: 'Username must be a text value.', sanitized: '' };
  }

  const sanitized = username.trim();

  if (!sanitized) {
    return { isValid: false, error: 'Username cannot be empty.', sanitized: '' };
  }

  if (sanitized.length < USERNAME_CONSTRAINTS.MIN_LENGTH) {
    return {
      isValid: false,
      error: `Username must be at least ${USERNAME_CONSTRAINTS.MIN_LENGTH} characters.`,
      sanitized
    };
  }

  if (sanitized.length > USERNAME_CONSTRAINTS.MAX_LENGTH) {
    return {
      isValid: false,
      error: `Username cannot exceed ${USERNAME_CONSTRAINTS.MAX_LENGTH} characters.`,
      sanitized
    };
  }

  if (!USERNAME_CONSTRAINTS.PATTERN.test(sanitized)) {
    return {
      isValid: false,
      error: 'Username can only contain letters, numbers, spaces, hyphens, underscores, and periods.',
      sanitized
    };
  }

  return { isValid: true, sanitized };
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
 * Fetches the user's persistent profile document from MongoDB via Express API (with local offline cache).
 * @param {string} userId - Authenticated user UID (or guest identifier)
 * @returns {Promise<{ uid: string, username?: string, email?: string } | null>}
 */
export async function getUserProfile(userId) {
  if (!userId) return null;

  const cached = getCachedUserProfile(userId);

  // Guest users or offline browser environment: immediately return local cache
  if (userId.startsWith('guest-') || !isBrowserOnline()) {
    return cached;
  }

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (controller) {
      timer = setTimeout(() => controller.abort(), 4000);
    }

    const { res: response } = await authorizedApiFetch(
      '/api/users/me',
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
        if (data?.user) {
          const profile = {
            uid: data.user.uid || userId,
            username: data.user.username || '',
            email: data.user.email || ''
          };
          saveCachedUserProfile(userId, profile);
          return profile;
        }
      } else if (response.status === 404) {
        // User is authenticated in Firebase but no profile document exists yet in MongoDB.
        // Return cached if available, else null so caller can create one or fallback to displayName.
        return cached || null;
      } else {
        console.warn(`[UserProfileService] Profile fetch returned HTTP ${response.status}`);
      }
    }
  } catch (err) {
    console.warn('Could not retrieve user profile from backend API, using local cache if available:', err?.message || err);
  }

  return cached;
}

/**
 * Persists the user profile to MongoDB Atlas via Express API and syncs displayName with Firebase Auth.
 * @param {string} userId - Authenticated user UID
 * @param {Object} data
 * @param {string} data.username
 * @param {string} [data.email]
 * @returns {Promise<void>}
 */
export async function saveUserProfile(userId, { username, email = '' }) {
  const { isValid, error, sanitized } = validateUsername(username);
  if (!isValid) {
    throw new Error(error);
  }

  const existingCached = userId ? getCachedUserProfile(userId) : null;
  const effectiveEmail = email || existingCached?.email || auth?.currentUser?.email || '';

  // 1. Immediately update local cache for instant UI feedback and offline continuity
  if (userId) {
    saveCachedUserProfile(userId, {
      uid: userId,
      username: sanitized,
      email: effectiveEmail
    });
  }

  // 2. Sync with Firebase Authentication profile displayName if active
  if (auth?.currentUser && (auth.currentUser.uid === userId || !userId)) {
    try {
      await updateProfile(auth.currentUser, {
        displayName: sanitized
      });
    } catch (authErr) {
      console.warn('Could not update Firebase Auth displayName:', authErr?.message || authErr);
    }
  }

  // 3. Guest sessions: guest data remains in local cache/sessionStorage only
  if (userId?.startsWith('guest-') || auth?.currentUser?.isAnonymous) {
    return;
  }

  // 4. Offline mode: local cache updated, defer cloud write without crashing
  if (!isBrowserOnline()) {
    return;
  }

  // 5. Persist to MongoDB via Express API (PUT /api/users/me)
  // Identity is derived exclusively from the verified token on the server
  try {
    const { res: response, token } = await authorizedApiFetch('/api/users/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: sanitized,
        email: effectiveEmail
      })
    });

    if (!token || !response) {
      // If user is not yet fully authenticated with a valid token, local cache and auth displayName are saved
      return;
    }

    if (response.ok) {
      const data = await response.json();
      if (data?.user) {
        saveCachedUserProfile(userId, {
          uid: data.user.uid || userId,
          username: data.user.username,
          email: data.user.email || ''
        });
      }
    } else {
      let errMsg = '';
      try {
        const errJson = await response.json();
        errMsg = errJson?.error || `HTTP ${response.status}`;
      } catch (_) {
        errMsg = `HTTP ${response.status}`;
      }

      if (response.status === 400) {
        throw new Error(errMsg || 'Invalid username provided.');
      } else if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication required to save profile: ${errMsg}`);
      } else {
        // Server 500 / 503 / temporary maintenance: log warning, do not crash UI
        console.warn(`[UserProfileService] Could not persist profile to MongoDB (HTTP ${response.status}): ${errMsg}`);
      }
    }
  } catch (apiErr) {
    if (apiErr?.message?.includes('Invalid username') || apiErr?.message?.includes('Authentication required')) {
      throw apiErr;
    }
    console.warn('Network error while saving profile to backend API:', apiErr?.message || apiErr);
  }
}
