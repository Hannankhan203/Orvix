/**
 * Orvix Authorized MongoDB API Client
 *
 * Centralizes authenticated HTTP communication with the Express/MongoDB backend.
 * Features:
 * - Automatically injects Firebase Auth Bearer ID token in `Authorization` header
 * - Detects HTTP 401 Unauthorized responses
 * - Automatically refreshes the Firebase ID token once on 401 and retries the same request
 * - Strictly prevents retry loops (retries at most once)
 * - Safely handles guest / unauthenticated requests without attempting token refresh
 * - Deduplicates concurrent token refresh operations
 * - Provides setAuthTokenProviderForTesting hook for unit and integration test suites
 */

import { auth } from '../config/firebaseConfig.js';

let customTokenProvider = null;
let activeRefreshPromise = null;

/**
 * Testing hook allowing unit and integration tests to supply mocked Firebase ID tokens.
 * @param {((forceRefresh?: boolean) => Promise<string|null>)|null} provider
 */
export function setAuthTokenProviderForTesting(provider) {
  customTokenProvider = provider;
}

/**
 * Helper to resolve the API endpoint URL in both browser and test/server environments.
 * @param {string} endpointPath
 * @returns {string}
 */
export function getApiEndpoint(endpointPath) {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return endpointPath;
  }
  const base = (typeof process !== 'undefined' && process.env?.TEST_API_BASE) || 'http://localhost:3000';
  return `${base}${endpointPath}`;
}

/**
 * Helper to securely obtain current user's Firebase ID token.
 * Supports concurrent refresh request deduplication.
 *
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<string|null>}
 */
export async function resolveAuthToken(forceRefresh = false) {
  if (customTokenProvider) {
    if (forceRefresh) {
      if (!activeRefreshPromise) {
        activeRefreshPromise = Promise.resolve()
          .then(() => customTokenProvider(true))
          .finally(() => {
            activeRefreshPromise = null;
          });
      }
      return activeRefreshPromise;
    }
    return customTokenProvider(false);
  }

  if (forceRefresh) {
    if (!activeRefreshPromise) {
      activeRefreshPromise = Promise.resolve()
        .then(async () => {
          try {
            if (auth?.currentUser?.getIdToken) {
              return await auth.currentUser.getIdToken(true);
            }
          } catch (err) {
            console.warn('Could not refresh Firebase ID token:', err?.message || err);
          }
          return null;
        })
        .finally(() => {
          activeRefreshPromise = null;
        });
    }
    return activeRefreshPromise;
  }

  try {
    if (auth?.currentUser?.getIdToken) {
      return await auth.currentUser.getIdToken(false);
    }
  } catch (err) {
    console.warn('Could not resolve Firebase ID token:', err?.message || err);
  }
  return null;
}

/**
 * Performs an authenticated fetch against the Express/MongoDB API using Bearer ID token,
 * automatically retrying exactly once with a force-refreshed token if the server responds with 401.
 *
 * @param {string} endpointPath
 * @param {RequestInit} [options={}]
 * @returns {Promise<{ res: Response | null, token: string | null }>}
 */
export async function authorizedApiFetch(endpointPath, options = {}) {
  let token = await resolveAuthToken(false);
  if (!token) {
    return { res: null, token: null };
  }

  const endpoint = getApiEndpoint(endpointPath);
  const execute = (bearerToken) =>
    fetch(endpoint, {
      ...options,
      headers: {
        'Accept': 'application/json',
        ...(options.headers || {}),
        'Authorization': `Bearer ${bearerToken}`
      }
    });

  let res = await execute(token);
  if (res.status === 401) {
    const refreshed = await resolveAuthToken(true);
    if (refreshed) {
      token = refreshed;
      res = await execute(token);
    }
  }

  return { res, token };
}
