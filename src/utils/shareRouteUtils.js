/**
 * Lightweight share-route URL parsing and share ID validation helpers.
 * Kept free of Firestore/storage dependencies so root entry routing does not
 * pull chat or attachment services into the initial bundle.
 */

export const SHARE_ID_REGEX = /^[a-zA-Z0-9_-]{12,128}$/;

/**
 * Validates whether a share ID matches the canonical Firestore rule format.
 *
 * @param {string} shareId
 * @returns {boolean}
 */
export function isValidShareId(shareId) {
  return typeof shareId === 'string' && SHARE_ID_REGEX.test(shareId);
}

/**
 * Extracts and parses a share ID from a window pathname (e.g. '/share/abc123_456').
 * Returns the shareId string if matched, or null otherwise.
 *
 * @param {string} [pathname]
 * @returns {string|null}
 */
export function parseSharePath(pathname) {
  const target =
    typeof pathname === 'string'
      ? pathname.trim()
      : typeof window !== 'undefined'
      ? window.location?.pathname || ''
      : '';

  if (!target) return null;
  const match = target.match(/^\/share\/([a-zA-Z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

/**
 * Analyzes whether a given pathname represents a /share route and evaluates ID validity.
 *
 * @param {string} [pathname]
 * @returns {{ isShareRoute: boolean, shareId: string|null, rawShareId: string|null, isValid: boolean, isMalformed: boolean }}
 */
export function getShareRouteDetails(pathname) {
  const target =
    typeof pathname === 'string'
      ? pathname.trim()
      : typeof window !== 'undefined'
      ? window.location?.pathname || ''
      : '';

  if (!target || !target.startsWith('/share')) {
    return { isShareRoute: false, shareId: null, rawShareId: null, isValid: false, isMalformed: false };
  }

  // Handle bare /share or /share/
  if (target === '/share' || target === '/share/') {
    return { isShareRoute: true, shareId: null, rawShareId: '', isValid: false, isMalformed: true };
  }

  const match = target.match(/^\/share\/([^/?#]+)\/?$/);
  if (!match) {
    return { isShareRoute: true, shareId: null, rawShareId: null, isValid: false, isMalformed: true };
  }

  const rawShareId = match[1];
  const isValid = isValidShareId(rawShareId);

  return {
    isShareRoute: true,
    shareId: isValid ? rawShareId : null,
    rawShareId,
    isValid,
    isMalformed: !isValid
  };
}
