/**
 * Orvix Authentication Service
 * Dedicated service isolating Firebase Auth calls from React UI components.
 */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import { auth, isFirebaseConfigured } from '../config/firebaseConfig.js';
export { getUserProfile, saveUserProfile, validateUsername } from './userProfileService.js';

/**
 * Normalizes Firebase Auth error codes into clear, user-friendly messages.
 * @param {Error|Object} error
 * @returns {string}
 */
export function formatAuthError(error) {
  const code = error?.code || '';

  switch (code) {
    case 'auth/invalid-email':
      return 'The email address format is invalid.';
    case 'auth/user-disabled':
      return 'This user account has been disabled. Please contact support.';
    case 'auth/user-not-found':
      return 'No account was found with this email address.';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password. Please check your credentials.';
    case 'auth/email-already-in-use':
      return 'An account already exists with this email. Try logging in instead.';
    case 'auth/weak-password':
      return 'The password is too weak. Please use at least 6 characters.';
    case 'auth/operation-not-allowed':
      return 'Email/Password sign-in is not enabled in your Firebase Console.';
    case 'auth/too-many-requests':
      return 'Access to this account has been temporarily disabled due to many failed login attempts. Try again later.';
    case 'auth/network-request-failed':
      return 'Network connection error. Please verify your internet connection.';
    case 'auth/popup-closed-by-user':
      return 'Authentication was cancelled.';
    case 'auth/requires-recent-login':
      return 'Please sign in again before performing this action.';
    default: {
      const msg = error?.message || 'An unexpected authentication error occurred.';
      return String(msg)
        .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
        .replace(/Firebase:\s*/g, '')
        .replace(/\(auth\/[a-z0-9-]+\)\.?/g, '')
        .trim() || 'Authentication failed. Please verify your credentials.';
    }
  }
}

/**
 * Creates a new user account with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export async function signupWithEmail(email, password) {
  if (!isFirebaseConfigured() || !auth) {
    throw new Error(
      'Firebase is not configured. Please supply valid VITE_FIREBASE_* environment variables.'
    );
  }
  return createUserWithEmailAndPassword(auth, email.trim(), password);
}

/**
 * Authenticates an existing user with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export async function loginWithEmail(email, password) {
  if (!isFirebaseConfigured() || !auth) {
    throw new Error(
      'Firebase is not configured. Please supply valid VITE_FIREBASE_* environment variables.'
    );
  }
  return signInWithEmailAndPassword(auth, email.trim(), password);
}

/**
 * Signs out the currently authenticated user.
 * @returns {Promise<void>}
 */
export async function logout() {
  if (!auth) return Promise.resolve();
  return signOut(auth);
}

/**
 * Subscribes to Firebase authentication state changes.
 * @param {(user: import('firebase/auth').User | null) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onAuthChange(callback) {
  if (!auth) {
    // If Firebase is not configured, inform subscriber immediately with null
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

/**
 * Retrieves a fresh, verified Firebase ID token for an authenticated user.
 * Throws a descriptive error if token acquisition fails or token is empty.
 * Never downgrades an authenticated user to guest identity.
 *
 * @param {import('firebase/auth').User|null} user
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<string>}
 */
export async function getFreshIdToken(user, forceRefresh = false) {
  if (!user || typeof user.getIdToken !== 'function') {
    throw new Error('Authentication required. Please sign in to continue.');
  }

  try {
    const token = await user.getIdToken(forceRefresh);
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('Authentication token could not be retrieved.');
    }
    return token.trim();
  } catch (err) {
    const message = err?.message || 'Failed to acquire authentication token';
    console.error('[AuthService] Fresh ID token retrieval failed:', err);
    throw new Error(`Your session has expired or authentication failed. Please sign in again. (${message})`);
  }
}

/**
 * Validates and retrieves the persistent guest identity from storage.
 * If absent or malformed, generates and persists a valid guest ID.
 * Guarantees that guest ID matches the server requirement (/^guest-[a-z0-9_-]{4,64}$/i).
 *
 * @returns {string}
 */
export function getOrCreatePersistentGuestId() {
  const GUEST_ID_REGEX = /^guest-[a-z0-9_-]{4,64}$/i;

  if (typeof window === 'undefined') {
    return 'guest-server-session';
  }

  try {
    const candidateJson =
      sessionStorage.getItem('orvix_guest_session') ||
      localStorage.getItem('orvix_guest_session');

    if (candidateJson) {
      const parsed = JSON.parse(candidateJson);
      if (parsed?.uid && GUEST_ID_REGEX.test(parsed.uid)) {
        return parsed.uid;
      }
    }
  } catch (_) {}

  // Generate new persistent, validated guest identifier
  const randomSuffix =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).substring(2, 12);
  const newGuestId = `guest-${randomSuffix}`;

  try {
    const sessionObj = {
      uid: newGuestId,
      username: 'Guest Explorer',
      email: 'guest@orvix.ai',
      isAnonymous: true
    };
    const serialized = JSON.stringify(sessionObj);
    sessionStorage.setItem('orvix_guest_session', serialized);
    localStorage.setItem('orvix_guest_session', serialized);
  } catch (_) {}

  return newGuestId;
}
