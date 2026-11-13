/**
 * Orvix Daily Attachment Upload Quota Client Service (P4)
 *
 * Responsibilities:
 * 1. Parses authoritative rate-limit headers (`X-RateLimit-Remaining`, `X-RateLimit-Limit`, `X-RateLimit-Reset-UTC`)
 *    from backend upload and quota status responses.
 * 2. Never calculates or decrements quota independently using frontend counters.
 * 3. Strictly scopes quota state to the currently authenticated Firebase account (`userId`).
 * 4. Handles initial loading, network failures, and missing headers gracefully without fabricating values.
 * 5. Automatically detects UTC calendar day rollover and resets displayed quota for the new UTC day.
 */

import { getAuthHeaders, getAuthUserId } from './authService.js';

export const DEFAULT_DAILY_UPLOAD_LIMIT = 5;

let customClientDateHook = null;
let customFetchHook = null;

/**
 * Test hook to override current Date for deterministic UTC midnight rollover tests.
 * @param {(() => Date) | null} hook
 */
export function setClientQuotaDateHookForTesting(hook) {
  customClientDateHook = typeof hook === 'function' ? hook : null;
}

/**
 * Test hook to override fetch implementation in automated tests.
 * @param {typeof fetch | null} fn
 */
export function setClientQuotaFetchForTesting(fn) {
  customFetchHook = typeof fn === 'function' ? fn : null;
}

/**
 * Returns current Date using active test hook or system clock.
 * @returns {Date}
 */
export function getClientQuotaCurrentDate() {
  if (customClientDateHook) {
    return customClientDateHook();
  }
  return new Date();
}

/**
 * Returns YYYY-MM-DD UTC calendar day string for a Date.
 * @param {Date} [date]
 * @returns {string}
 */
export function getClientUtcDayString(date = getClientQuotaCurrentDate()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns the ISO string of the next UTC midnight for a Date.
 * @param {Date} [date]
 * @returns {string}
 */
export function getClientNextUtcMidnightIso(date = getClientQuotaCurrentDate()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0)
  ).toISOString();
}

/**
 * Helper to read a header value case-insensitively from Fetch Headers, Response, or plain object.
 * @param {any} headersOrResponse
 * @param {string} headerName
 * @returns {string | null}
 */
function readHeaderValue(headersOrResponse, headerName) {
  if (!headersOrResponse) return null;
  const headers =
    headersOrResponse.headers && typeof headersOrResponse.headers === 'object'
      ? headersOrResponse.headers
      : headersOrResponse;

  if (!headers) return null;

  if (typeof headers.get === 'function') {
    const val = headers.get(headerName) ?? headers.get(headerName.toLowerCase());
    return val !== null && val !== undefined ? String(val).trim() : null;
  }

  if (typeof headers === 'object') {
    const lowerTarget = headerName.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (String(k).toLowerCase() === lowerTarget && v !== undefined && v !== null) {
        return Array.isArray(v) ? String(v[0]).trim() : String(v).trim();
      }
    }
  }

  return null;
}

/**
 * Parses authoritative upload quota metadata exclusively from backend HTTP response headers.
 *
 * Security & Accuracy Invariant:
 * - Requires `X-RateLimit-Remaining` header to be present and a valid non-negative integer.
 * - If `X-RateLimit-Remaining` is missing or malformed, returns `null` (never guesses or uses frontend math).
 *
 * @param {Response | Headers | Record<string, any> | null | undefined} responseOrHeaders
 * @returns {{ remaining: number, limit: number, resetAt: string } | null}
 */
export function extractQuotaFromHeaders(responseOrHeaders) {
  if (!responseOrHeaders) return null;

  const rawRemaining = readHeaderValue(responseOrHeaders, 'X-RateLimit-Remaining');
  if (rawRemaining === null || rawRemaining === '') {
    return null;
  }

  const parsedRemaining = Number(rawRemaining);
  if (!Number.isFinite(parsedRemaining) || !Number.isInteger(parsedRemaining) || parsedRemaining < 0) {
    return null;
  }

  const rawLimit = readHeaderValue(responseOrHeaders, 'X-RateLimit-Limit');
  let parsedLimit = DEFAULT_DAILY_UPLOAD_LIMIT;
  if (rawLimit !== null && rawLimit !== '') {
    const candidateLimit = Number(rawLimit);
    if (Number.isFinite(candidateLimit) && Number.isInteger(candidateLimit) && candidateLimit > 0) {
      parsedLimit = candidateLimit;
    }
  }

  const clampedRemaining = Math.min(parsedLimit, Math.max(0, parsedRemaining));

  const rawResetAt = readHeaderValue(responseOrHeaders, 'X-RateLimit-Reset-UTC');
  const resetAt =
    rawResetAt && !Number.isNaN(Date.parse(rawResetAt))
      ? rawResetAt
      : getClientNextUtcMidnightIso();

  return {
    remaining: clampedRemaining,
    limit: parsedLimit,
    resetAt
  };
}

/**
 * Formats the daily upload quota state into the required user-facing string:
 *   - "5 of 5 uploads remaining today"
 *   - "3 of 5 uploads remaining today"
 *   - "0 of 5 uploads remaining today"
 *
 * Returns null if quota state is not ready or remaining count is unknown.
 *
 * @param {{ remaining?: number | null, limit?: number, status?: string } | null | undefined} quotaState
 * @returns {string | null}
 */
export function formatDailyUploadQuotaText(quotaState) {
  if (!quotaState || typeof quotaState !== 'object') {
    return null;
  }

  const { remaining, limit = DEFAULT_DAILY_UPLOAD_LIMIT } = quotaState;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) {
    return null;
  }

  const effectiveLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? limit
      : DEFAULT_DAILY_UPLOAD_LIMIT;

  const safeRemaining = Math.min(effectiveLimit, Math.max(0, Math.floor(remaining)));
  return `${safeRemaining} of ${effectiveLimit} uploads remaining today`;
}

/**
 * Checks whether a userId represents a real authenticated Firebase account (not guest/anonymous).
 * @param {string | null | undefined} userId
 * @returns {boolean}
 */
export function isEligibleQuotaUserId(userId) {
  if (!userId || typeof userId !== 'string') return false;
  const trimmed = userId.trim();
  if (!trimmed) return false;
  if (trimmed === 'guest' || trimmed.startsWith('guest-') || trimmed.startsWith('local-')) {
    return false;
  }
  return true;
}

function createInitialQuotaState(userId = null) {
  const cleanUid = isEligibleQuotaUserId(userId) ? userId.trim() : null;
  return {
    userId: cleanUid,
    remaining: null,
    limit: DEFAULT_DAILY_UPLOAD_LIMIT,
    resetAt: null,
    utcDay: null,
    status: cleanUid ? 'idle' : 'unauthenticated',
    lastUpdatedAt: null
  };
}

let currentQuotaState = createInitialQuotaState(null);
const quotaStateListeners = new Set();
let activeFetchSequence = 0;

function notifyQuotaStateListeners() {
  const snapshot = getUploadQuotaState();
  quotaStateListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (_) {}
  });
}

/**
 * Checks whether the UTC calendar day has rolled over since the current quota snapshot was recorded.
 * If the UTC day has changed for an authenticated user with an active quota snapshot,
 * resets the displayed quota to the daily limit (`5 of 5 uploads remaining today`) for the new UTC day.
 *
 * @param {{ triggerRefresh?: boolean }} [options]
 * @returns {boolean} True if a UTC day rollover reset occurred
 */
export function checkUploadQuotaUtcRollover(options = {}) {
  if (!currentQuotaState.userId || !isEligibleQuotaUserId(currentQuotaState.userId)) {
    return false;
  }

  if (typeof currentQuotaState.remaining !== 'number' || !currentQuotaState.utcDay) {
    return false;
  }

  const now = getClientQuotaCurrentDate();
  const currentUtcDay = getClientUtcDayString(now);
  const resetAtMs = currentQuotaState.resetAt ? Date.parse(currentQuotaState.resetAt) : NaN;
  const hasResetTimePassed = !Number.isNaN(resetAtMs) && now.getTime() >= resetAtMs;

  if (currentUtcDay !== currentQuotaState.utcDay || hasResetTimePassed) {
    const limit = currentQuotaState.limit || DEFAULT_DAILY_UPLOAD_LIMIT;
    currentQuotaState = {
      ...currentQuotaState,
      remaining: limit,
      limit,
      utcDay: currentUtcDay,
      resetAt: getClientNextUtcMidnightIso(now),
      status: 'ready',
      lastUpdatedAt: now.getTime()
    };
    notifyQuotaStateListeners();

    if (options.triggerRefresh) {
      void fetchAuthenticatedUploadQuota({ userId: currentQuotaState.userId }).catch(() => {});
    }
    return true;
  }

  return false;
}

/**
 * Returns a copy of the current upload quota state, automatically applying UTC day rollover if needed.
 * @returns {{
 *   userId: string | null,
 *   remaining: number | null,
 *   limit: number,
 *   resetAt: string | null,
 *   utcDay: string | null,
 *   status: 'unauthenticated' | 'idle' | 'loading' | 'ready' | 'unavailable',
 *   lastUpdatedAt: number | null,
 *   formattedText: string | null
 * }}
 */
export function getUploadQuotaState() {
  checkUploadQuotaUtcRollover({ triggerRefresh: false });
  return {
    ...currentQuotaState,
    formattedText: formatDailyUploadQuotaText(currentQuotaState)
  };
}

/**
 * Subscribes to changes in the daily upload quota state.
 * @param {(state: ReturnType<typeof getUploadQuotaState>) => void} listener
 * @returns {() => void} Unsubscribe function
 */
export function subscribeUploadQuotaState(listener) {
  if (typeof listener !== 'function') return () => {};
  quotaStateListeners.add(listener);
  return () => {
    quotaStateListeners.delete(listener);
  };
}

/**
 * Synchronizes the quota store with the currently active Firebase user ID.
 * Ensures strict account isolation: switching accounts or signing out immediately
 * clears any previous user's quota state so another user's quota is never displayed.
 *
 * @param {string | null | undefined} userId
 * @param {{ autoFetch?: boolean }} [options]
 */
export function syncUploadQuotaUserAccount(userId, options = { autoFetch: true }) {
  const cleanUid = isEligibleQuotaUserId(userId) ? userId.trim() : null;

  if (!cleanUid) {
    activeFetchSequence++;
    if (currentQuotaState.userId !== null || currentQuotaState.status !== 'unauthenticated') {
      currentQuotaState = createInitialQuotaState(null);
      notifyQuotaStateListeners();
    }
    return getUploadQuotaState();
  }

  if (currentQuotaState.userId !== cleanUid) {
    activeFetchSequence++;
    currentQuotaState = createInitialQuotaState(cleanUid);
    notifyQuotaStateListeners();
    if (options?.autoFetch !== false) {
      void fetchAuthenticatedUploadQuota({ userId: cleanUid }).catch(() => {});
    }
    return getUploadQuotaState();
  }

  checkUploadQuotaUtcRollover({ triggerRefresh: options?.autoFetch !== false });
  if (currentQuotaState.status === 'idle' && options?.autoFetch !== false) {
    void fetchAuthenticatedUploadQuota({ userId: cleanUid }).catch(() => {});
  }
  return getUploadQuotaState();
}

/**
 * Updates the client quota state exclusively from a backend HTTP response's `X-RateLimit-Remaining` header.
 *
 * Crucial Invariants:
 * 1. Never decrements or calculates quota using frontend counters.
 * 2. If `X-RateLimit-Remaining` header is missing, leaves existing valid quota state untouched
 *    (or marks unavailable if no state was ever loaded) without fabricating numbers.
 * 3. Works identically for HTTP 200 (successful upload) and HTTP 429 (quota exceeded).
 * 4. Enforces account isolation: ignores responses belonging to a different userId.
 *
 * @param {Response | Headers | Record<string, any> | null | undefined} responseOrHeaders
 * @param {string | null} [expectedUserId]
 * @returns {ReturnType<typeof getUploadQuotaState>}
 */
export function updateUploadQuotaFromResponse(responseOrHeaders, expectedUserId = undefined) {
  const activeUid =
    expectedUserId !== undefined
      ? (isEligibleQuotaUserId(expectedUserId) ? expectedUserId.trim() : null)
      : (currentQuotaState.userId || getAuthUserId());

  if (!isEligibleQuotaUserId(activeUid)) {
    return getUploadQuotaState();
  }

  // Account isolation: if a user account is already active and an in-flight response
  // arrives for a different expectedUserId, ignore the stale response from the previous account.
  if (expectedUserId !== undefined && currentQuotaState.userId && currentQuotaState.userId !== activeUid) {
    return getUploadQuotaState();
  }

  const parsed = extractQuotaFromHeaders(responseOrHeaders);
  if (!parsed) {
    // Missing X-RateLimit-Remaining header: do NOT guess or decrement locally!
    if (currentQuotaState.userId !== activeUid) {
      currentQuotaState = {
        ...createInitialQuotaState(activeUid),
        status: 'unavailable'
      };
      notifyQuotaStateListeners();
    } else if (currentQuotaState.status === 'loading' || currentQuotaState.status === 'idle') {
      currentQuotaState = {
        ...currentQuotaState,
        userId: activeUid,
        status: 'unavailable'
      };
      notifyQuotaStateListeners();
    }
    return getUploadQuotaState();
  }

  const now = getClientQuotaCurrentDate();
  currentQuotaState = {
    userId: activeUid,
    remaining: parsed.remaining,
    limit: parsed.limit,
    resetAt: parsed.resetAt,
    utcDay: getClientUtcDayString(now),
    status: 'ready',
    lastUpdatedAt: now.getTime()
  };

  notifyQuotaStateListeners();
  return getUploadQuotaState();
}

/**
 * Fetches the authenticated user's current daily upload quota from `GET /api/upload/quota`
 * without consuming or reserving an upload slot.
 *
 * @param {{ userId?: string | null, endpoint?: string, headersOverride?: Record<string, string>, getTokenFn?: () => Promise<string | null> }} [options]
 * @returns {Promise<ReturnType<typeof getUploadQuotaState>>}
 */
export async function fetchAuthenticatedUploadQuota(options = {}) {
  const targetUid =
    options.userId !== undefined
      ? (isEligibleQuotaUserId(options.userId) ? options.userId.trim() : null)
      : (currentQuotaState.userId || getAuthUserId());

  if (!isEligibleQuotaUserId(targetUid)) {
    syncUploadQuotaUserAccount(null, { autoFetch: false });
    return getUploadQuotaState();
  }

  if (currentQuotaState.userId !== targetUid) {
    currentQuotaState = createInitialQuotaState(targetUid);
  }

  const seq = ++activeFetchSequence;
  if (typeof currentQuotaState.remaining !== 'number') {
    currentQuotaState = {
      ...currentQuotaState,
      userId: targetUid,
      status: 'loading'
    };
    notifyQuotaStateListeners();
  }

  try {
    let authHeaders = options.headersOverride;
    if (!authHeaders && typeof options.getTokenFn === 'function') {
      const token = await options.getTokenFn();
      authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    }
    if (!authHeaders) {
      authHeaders = await getAuthHeaders();
    }

    // Ensure user did not sign out or switch accounts while awaiting auth headers
    if (seq !== activeFetchSequence || currentQuotaState.userId !== targetUid) {
      return getUploadQuotaState();
    }

    if (!authHeaders || (!authHeaders.Authorization && !authHeaders.authorization)) {
      if (typeof currentQuotaState.remaining !== 'number') {
        currentQuotaState = {
          ...currentQuotaState,
          status: 'unavailable'
        };
        notifyQuotaStateListeners();
      }
      return getUploadQuotaState();
    }

    const fetchFn = customFetchHook || globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      if (typeof currentQuotaState.remaining !== 'number') {
        currentQuotaState = {
          ...currentQuotaState,
          status: 'unavailable'
        };
        notifyQuotaStateListeners();
      }
      return getUploadQuotaState();
    }

    const endpoint = options.endpoint || '/api/upload/quota';
    const response = await fetchFn(endpoint, {
      method: 'GET',
      headers: {
        ...authHeaders,
        Accept: 'application/json'
      },
      cache: 'no-store'
    });

    if (seq !== activeFetchSequence || currentQuotaState.userId !== targetUid) {
      return getUploadQuotaState();
    }

    const parsedHeaders = extractQuotaFromHeaders(response);
    if (parsedHeaders) {
      return updateUploadQuotaFromResponse(response, targetUid);
    }

    // Response lacked authoritative X-RateLimit-Remaining header or failed without quota headers
    if (typeof currentQuotaState.remaining !== 'number') {
      currentQuotaState = {
        ...currentQuotaState,
        userId: targetUid,
        status: 'unavailable'
      };
      notifyQuotaStateListeners();
    }
    return getUploadQuotaState();
  } catch (_) {
    if (seq === activeFetchSequence && currentQuotaState.userId === targetUid) {
      if (typeof currentQuotaState.remaining !== 'number') {
        currentQuotaState = {
          ...currentQuotaState,
          userId: targetUid,
          status: 'unavailable'
        };
        notifyQuotaStateListeners();
      }
    }
    return getUploadQuotaState();
  }
}

/**
 * Resets all client upload quota state and test hooks for isolated testing.
 */
export function resetClientUploadQuotaForTesting() {
  activeFetchSequence++;
  customClientDateHook = null;
  customFetchHook = null;
  currentQuotaState = createInitialQuotaState(null);
  quotaStateListeners.clear();
}

export const resetUploadQuotaClientStateForTesting = resetClientUploadQuotaForTesting;
