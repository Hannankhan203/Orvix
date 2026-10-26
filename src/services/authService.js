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
 * Retrieves the current user's Firebase Auth ID token for authenticating backend requests.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<string|null>}
 */
export async function getIdToken(forceRefresh = false) {
  if (!auth || !auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken(forceRefresh);
  } catch (err) {
    console.warn('Failed to retrieve Firebase ID token:', err?.message || err);
    return null;
  }
}

export {
  authorizedApiFetch,
  resolveAuthToken,
  getApiEndpoint,
  setAuthTokenProviderForTesting
} from './mongoApiClient.js';


