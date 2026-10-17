/**
 * Firebase Client Configuration
 * Reads configuration parameters from Vite environment variables.
 *
 * NOTE: Never hardcode credentials. Values are read from import.meta.env.VITE_FIREBASE_*
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

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

if (isFirebaseConfigured()) {
  try {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (error) {
    console.error('Failed to initialize Firebase App or Firestore:', error);
  }
}

export { app, auth, db };
