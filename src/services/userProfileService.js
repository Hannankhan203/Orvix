/**
 * Orvix User Profile Service
 * Handles user profile persistence in Cloud Firestore under /users/{userId},
 * username validation, and synchronization with Firebase Auth.
 */

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { updateProfile } from 'firebase/auth';
import { db, auth, isFirebaseConfigured } from '../config/firebaseConfig.js';

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

/**
 * Fetches the user's persistent profile document from Cloud Firestore.
 * @param {string} userId - Authenticated user UID
 * @returns {Promise<{ uid: string, username?: string, email?: string } | null>}
 */
export async function getUserProfile(userId) {
  if (!db || !isFirebaseConfigured() || !userId) {
    return null;
  }

  try {
    const profileRef = doc(db, 'users', userId);
    const snap = await getDoc(profileRef);

    if (snap.exists()) {
      const data = snap.data();
      return {
        uid: userId,
        username: data.username || '',
        email: data.email || ''
      };
    }
  } catch (err) {
    console.warn('Could not retrieve user profile from Firestore:', err);
  }

  return null;
}

/**
 * Persists the user profile to Firestore and syncs displayName with Firebase Auth.
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

  // 1. Sync with Firebase Authentication profile displayName if active
  if (auth?.currentUser && auth.currentUser.uid === userId) {
    try {
      await updateProfile(auth.currentUser, {
        displayName: sanitized
      });
    } catch (authErr) {
      console.warn('Could not update Firebase Auth displayName:', authErr);
    }
  }

  // 2. Persist to Cloud Firestore under /users/{userId}
  if (!db || !isFirebaseConfigured() || !userId) {
    return;
  }

  try {
    const profileRef = doc(db, 'users', userId);
    const existingSnap = await getDoc(profileRef);

    if (existingSnap.exists()) {
      await setDoc(
        profileRef,
        {
          uid: userId,
          username: sanitized,
          email: email || existingSnap.data()?.email || '',
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } else {
      await setDoc(profileRef, {
        uid: userId,
        username: sanitized,
        email: email || '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
  } catch (firestoreErr) {
    console.error('Failed to save profile to Firestore:', firestoreErr);
    throw new Error(
      `Failed to save username to cloud storage: ${firestoreErr?.message || firestoreErr}`
    );
  }
}
