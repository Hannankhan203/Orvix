/**
 * Firebase Client Configuration
 * Reads configuration parameters from Vite environment variables.
 *
 * NOTE: Never hardcode credentials. Values are read from import.meta.env.VITE_FIREBASE_*
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, disableNetwork, enableNetwork } from 'firebase/firestore';

function getEnv(key) {
  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.[key]) {
      return import.meta.env[key];
    }
  } catch (_) {
    // Ignore error in non-Vite environments
  }
  if (typeof process !== 'undefined' && process.env?.[key]) {
    return process.env[key];
  }
  return '';
}

export const firebaseConfig = {
  apiKey: getEnv('VITE_FIREBASE_API_KEY'),
  authDomain: getEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: getEnv('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: getEnv('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: getEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: getEnv('VITE_FIREBASE_APP_ID')
};

/**
 * Checks whether the browser currently reports network connectivity.
 * Defaults to true in non-browser (SSR/Node) environments.
 * @returns {boolean}
 */
export function isBrowserOnline() {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

/**
 * Subscribes to browser online/offline transitions.
 * @param {(isOnline: boolean) => void} callback
 * @returns {() => void} Cleanup function
 */
export function subscribeToNetworkStatus(callback) {
  if (typeof window === 'undefined' || typeof callback !== 'function') {
    return () => {};
  }

  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}

/**
 * Checks if the required Firebase environment variables are provided and not placeholders.
 * @returns {boolean}
 */
export function isFirebaseConfigured() {
  const { apiKey, authDomain, projectId, appId } = firebaseConfig;
  if (!apiKey || !authDomain || !projectId || !appId) {
    return false;
  }
  // Check for common dummy placeholder tokens
  if (
    apiKey.includes('YOUR_') ||
    authDomain.includes('YOUR_') ||
    projectId.includes('YOUR_') ||
    appId.includes('YOUR_')
  ) {
    return false;
  }
  return true;
}

// Initialize Firebase App only if valid configuration is present
let app = null;
let auth = null;
let db = null;
let firestoreNetworkDisabled = false;
let networkTransitionChain = Promise.resolve();

/**
 * Pauses Firestore WebChannel network transport while offline to prevent
 * repeated failed Listen/Write retries and connectivity probe spam, and
 * re-enables Firestore transport when connectivity returns.
 * @param {boolean} [online=isBrowserOnline()]
 * @returns {Promise<void>}
 */
export function syncFirestoreNetworkState(online = isBrowserOnline()) {
  if (!db) {
    return Promise.resolve();
  }

  networkTransitionChain = networkTransitionChain
    .catch(() => {})
    .then(async () => {
      try {
        if (!online && !firestoreNetworkDisabled) {
          firestoreNetworkDisabled = true;
          await disableNetwork(db);
        } else if (online && firestoreNetworkDisabled) {
          firestoreNetworkDisabled = false;
          await enableNetwork(db);
        }
      } catch (err) {
        // Non-fatal: Firestore network toggling should never disrupt local chat
        console.warn('Firestore network state transition notice:', err?.message || err);
      }
    });

  return networkTransitionChain;
}

if (isFirebaseConfigured()) {
  try {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);

    if (!isBrowserOnline()) {
      void syncFirestoreNetworkState(false);
    }

    if (typeof window !== 'undefined') {
      subscribeToNetworkStatus((online) => {
        void syncFirestoreNetworkState(online);
      });
    }
  } catch (error) {
    console.error('Failed to initialize Firebase App or Firestore:', error);
  }
}

export { app, auth, db };
