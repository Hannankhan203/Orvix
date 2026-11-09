/**
 * Orvix Multilingual OCR Language Pack Service
 * Manages on-demand downloading, Cache API storage, offline reuse,
 * integrity verification, and lifecycle management for Tesseract language packs.
 *
 * Supported languages:
 * - English (eng): Built-in local default
 * - Spanish (spa): On-demand
 * - French (fra): On-demand
 * - German (deu): On-demand
 * - Arabic (ara): On-demand (RTL)
 * - Urdu (urd): On-demand (RTL)
 */

export const OCR_CACHE_NAME = 'orvix_ocr_packs_v1';
export const MIN_VALID_PACK_SIZE = 50 * 1024; // 50 KB sanity threshold

export const SUPPORTED_OCR_LANGUAGES = [
  {
    code: 'eng',
    name: 'English',
    nativeName: 'English',
    isDefault: true,
    isBuiltIn: true,
    fileSizeEstimate: '~5.2 MB',
    isRtl: false
  },
  {
    code: 'spa',
    name: 'Spanish',
    nativeName: 'Español',
    isDefault: false,
    isBuiltIn: false,
    fileSizeEstimate: '~1.1 MB',
    isRtl: false
  },
  {
    code: 'fra',
    name: 'French',
    nativeName: 'Français',
    isDefault: false,
    isBuiltIn: false,
    fileSizeEstimate: '~1.0 MB',
    isRtl: false
  },
  {
    code: 'deu',
    name: 'German',
    nativeName: 'Deutsch',
    isDefault: false,
    isBuiltIn: false,
    fileSizeEstimate: '~1.8 MB',
    isRtl: false
  },
  {
    code: 'ara',
    name: 'Arabic',
    nativeName: 'العربية',
    isDefault: false,
    isBuiltIn: false,
    fileSizeEstimate: '~1.6 MB',
    isRtl: true
  },
  {
    code: 'urd',
    name: 'Urdu',
    nativeName: 'اردو',
    isDefault: false,
    isBuiltIn: false,
    fileSizeEstimate: '~1.7 MB',
    isRtl: true
  }
];

// Primary and fallback CDN endpoints for Tesseract 4.0.0 fast traineddata
export const CDN_BASE_PRIMARY = 'https://tessdata.projectnaptha.com/4.0.0_fast';
export const CDN_BASE_FALLBACK = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast';

// In-memory fallback for headless test runners (e.g. Node.js) where window.caches is undefined
const memoryCache = new Map();

// Deduplicate concurrent active downloads by language code
const activeDownloads = new Map();

/**
 * Checks if a language code is among the supported OCR languages.
 * @param {string} code
 * @returns {boolean}
 */
export function isLanguageSupported(code) {
  if (!code || typeof code !== 'string') return false;
  const clean = code.toLowerCase().trim();
  return SUPPORTED_OCR_LANGUAGES.some((lang) => lang.code === clean);
}

/**
 * Gets language metadata for a given code.
 * @param {string} code
 * @returns {Object|null}
 */
export function getLanguageDetails(code) {
  if (!code || typeof code !== 'string') return null;
  const clean = code.toLowerCase().trim();
  return SUPPORTED_OCR_LANGUAGES.find((lang) => lang.code === clean) || null;
}

/**
 * Constructs the normalized cache key URL for a language pack.
 * @param {string} code
 * @returns {string}
 */
export function getPackCacheKey(code) {
  const clean = (code || '').toLowerCase().trim();
  return `https://orvix.local/ocr-packs/${clean}.traineddata.gz`;
}

/**
 * Validates language pack buffer integrity.
 * Returns false if buffer is null, below minimum size, or contains HTML error text.
 * @param {ArrayBuffer|Uint8Array|Buffer} buffer
 * @returns {boolean}
 */
export function validateLanguagePackBuffer(buffer) {
  if (!buffer) return false;
  const byteLength = buffer.byteLength || buffer.length || 0;
  if (byteLength < MIN_VALID_PACK_SIZE) return false;

  // Check for common 404/500 HTML error responses: <!DOCTYPE html> or <html
  try {
    const slice = new Uint8Array(buffer, 0, Math.min(100, byteLength));
    const headerStr = String.fromCharCode.apply(null, Array.from(slice)).toLowerCase();
    if (headerStr.includes('<!doctype html') || headerStr.includes('<html') || headerStr.includes('404: not found')) {
      return false;
    }
  } catch (_) {}

  return true;
}

/**
 * Returns the active Cache API instance, or null if running in an unsupported environment.
 * @returns {Promise<Cache|null>}
 */
async function getCacheStorage() {
  if (typeof caches !== 'undefined' && caches.open) {
    try {
      return await caches.open(OCR_CACHE_NAME);
    } catch (err) {
      console.warn('[OCR Language Pack] Cache API open error, falling back to memory:', err);
    }
  }
  return null;
}

/**
 * Checks whether a language pack is already downloaded and cached locally.
 * English ('eng') is built-in and always considered cached.
 *
 * @param {string} code - Language code (e.g. 'spa', 'fra')
 * @returns {Promise<boolean>}
 */
export async function isLanguagePackCached(code) {
  if (!code || !isLanguageSupported(code)) return false;
  const clean = code.toLowerCase().trim();
  if (clean === 'eng') return true;

  const key = getPackCacheKey(clean);

  // 1. Check in-memory fallback
  if (memoryCache.has(key)) {
    const item = memoryCache.get(key);
    if (validateLanguagePackBuffer(item)) return true;
    memoryCache.delete(key);
  }

  // 2. Check Cache API
  const cache = await getCacheStorage();
  if (!cache) return false;

  try {
    const response = await cache.match(key);
    if (!response || !response.ok) return false;

    // Check Content-Length header or inspect arrayBuffer
    const cl = response.headers.get('Content-Length');
    if (cl && parseInt(cl, 10) < MIN_VALID_PACK_SIZE) {
      await cache.delete(key);
      return false;
    }

    const cloned = response.clone();
    const buf = await cloned.arrayBuffer();
    if (!validateLanguagePackBuffer(buf)) {
      await cache.delete(key);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[OCR Language Pack] Error checking cache for ${clean}:`, err);
    return false;
  }
}

/**
 * Retrieves the cached language pack bytes.
 *
 * @param {string} code
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getCachedLanguagePack(code) {
  if (!code || !isLanguageSupported(code)) return null;
  const clean = code.toLowerCase().trim();
  const key = getPackCacheKey(clean);

  // Check in-memory
  if (memoryCache.has(key)) {
    const item = memoryCache.get(key);
    if (validateLanguagePackBuffer(item)) return item;
    memoryCache.delete(key);
  }

  const cache = await getCacheStorage();
  if (!cache) return null;

  try {
    const response = await cache.match(key);
    if (!response || !response.ok) return null;

    const buf = await response.arrayBuffer();
    if (!validateLanguagePackBuffer(buf)) {
      await cache.delete(key);
      return null;
    }
    return buf;
  } catch (err) {
    console.warn(`[OCR Language Pack] Error retrieving ${clean} from cache:`, err);
    return null;
  }
}

/**
 * Downloads a language pack on demand, showing progress, and saves it into the Cache API.
 * Deduplicates in-flight downloads to prevent redundant concurrent fetches.
 *
 * @param {string} code - Target language code ('spa', 'fra', 'deu', 'ara', 'urd')
 * @param {Object} [options]
 * @param {(progress: { loaded: number, total: number, percent: number }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ success: boolean, code: string, size: number, cached: boolean }>}
 */
export async function downloadLanguagePack(code, options = {}) {
  if (!code || typeof code !== 'string') {
    throw new Error('A valid language code is required.');
  }

  const clean = code.toLowerCase().trim();
  if (!isLanguageSupported(clean)) {
    const err = new Error(`Language "${code}" is not supported. Supported: eng, spa, fra, deu, ara, urd.`);
    err.code = 'UNSUPPORTED_LANGUAGE';
    throw err;
  }

  // English is built-in
  if (clean === 'eng') {
    options.onProgress?.({ loaded: 100, total: 100, percent: 100 });
    return { success: true, code: 'eng', size: 5200000, cached: true };
  }

  // If already cached and valid, return immediately
  const alreadyCached = await isLanguagePackCached(clean);
  if (alreadyCached) {
    const buf = await getCachedLanguagePack(clean);
    const size = buf ? buf.byteLength : 0;
    options.onProgress?.({ loaded: size, total: size, percent: 100 });
    return { success: true, code: clean, size, cached: true };
  }

  // Reuse in-flight download promise if already started
  if (activeDownloads.has(clean)) {
    return activeDownloads.get(clean);
  }

  const downloadPromise = (async () => {
    const filename = `${clean}.traineddata.gz`;
    const primaryUrl = `${CDN_BASE_PRIMARY}/${filename}`;
    const fallbackUrl = `${CDN_BASE_FALLBACK}/${filename}`;
    const localProxyUrl = `/api/ocr/packs/${filename}`;

    const candidateUrls = [localProxyUrl, primaryUrl, fallbackUrl];
    let lastError = null;

    for (const url of candidateUrls) {
      if (options.signal?.aborted) {
        throw new Error('Download aborted by user.');
      }

      try {
        const response = await fetch(url, { signal: options.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentLengthHeader = response.headers.get('Content-Length');
        const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

        let downloadedBytes = 0;
        let chunks = [];

        if (response.body && response.body.getReader) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              downloadedBytes += value.length;
              if (options.onProgress && typeof options.onProgress === 'function') {
                const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
                options.onProgress({ loaded: downloadedBytes, total: totalBytes, percent });
              }
            }
          }
        } else {
          const arrayBuffer = await response.arrayBuffer();
          const u8 = new Uint8Array(arrayBuffer);
          chunks = [u8];
          downloadedBytes = u8.length;
          options.onProgress?.({ loaded: downloadedBytes, total: downloadedBytes, percent: 100 });
        }

        // Assemble total Uint8Array
        const combined = new Uint8Array(downloadedBytes);
        let offset = 0;
        for (const c of chunks) {
          combined.set(c, offset);
          offset += c.length;
        }

        // Validate downloaded payload
        if (!validateLanguagePackBuffer(combined.buffer)) {
          throw new Error('Downloaded language pack failed integrity verification (file too small or invalid signature).');
        }

        // Save to Cache API
        const key = getPackCacheKey(clean);
        const cache = await getCacheStorage();

        if (cache) {
          const cachedResponse = new Response(combined.buffer, {
            status: 200,
            statusText: 'OK',
            headers: {
              'Content-Type': 'application/gzip',
              'Content-Length': String(combined.byteLength),
              'X-Language-Code': clean,
              'Cache-Control': 'public, max-age=31536000, immutable'
            }
          });
          await cache.put(key, cachedResponse);
        } else {
          // In-memory fallback
          memoryCache.set(key, combined.buffer);
        }

        return {
          success: true,
          code: clean,
          size: combined.byteLength,
          cached: true
        };
      } catch (err) {
        lastError = err;
        // If aborted, don't continue to next mirror
        if (options.signal?.aborted || err?.name === 'AbortError') {
          throw err;
        }
      }
    }

    const detailMsg = lastError?.message || 'Network request failed';
    const err = new Error(`Failed to download language pack for ${clean}: ${detailMsg}`);
    err.code = 'DOWNLOAD_FAILED';
    err.cause = lastError;
    throw err;
  })();

  activeDownloads.set(clean, downloadPromise);

  try {
    return await downloadPromise;
  } finally {
    activeDownloads.delete(clean);
  }
}

/**
 * Removes a downloaded language pack from local Cache API storage.
 * @param {string} code
 * @returns {Promise<boolean>}
 */
export async function deleteCachedLanguagePack(code) {
  if (!code) return false;
  const clean = code.toLowerCase().trim();
  const key = getPackCacheKey(clean);

  memoryCache.delete(key);

  const cache = await getCacheStorage();
  if (cache) {
    try {
      return await cache.delete(key);
    } catch (_) {
      return false;
    }
  }
  return true;
}

/**
 * Lists all language packs currently stored in Cache API.
 * @returns {Promise<Array<{ code: string, name: string, nativeName: string, isRtl: boolean, isBuiltIn: boolean }>>}
 */
export async function listCachedLanguagePacks() {
  const list = [];

  for (const lang of SUPPORTED_OCR_LANGUAGES) {
    if (lang.code === 'eng') {
      list.push({ ...lang, isCached: true });
    } else {
      const isCached = await isLanguagePackCached(lang.code);
      if (isCached) {
        list.push({ ...lang, isCached: true });
      }
    }
  }

  return list;
}

/**
 * Deletes all non-English language packs from local cache.
 * @returns {Promise<number>} Number of removed packs
 */
export async function clearLanguagePackCache() {
  let count = 0;
  for (const lang of SUPPORTED_OCR_LANGUAGES) {
    if (lang.code !== 'eng') {
      const wasCached = await isLanguagePackCached(lang.code);
      if (wasCached) {
        await deleteCachedLanguagePack(lang.code);
        count++;
      }
    }
  }
  return count;
}

/**
 * Test helper: resets in-memory mock cache.
 */
export function resetOcrCacheForTesting() {
  memoryCache.clear();
  activeDownloads.clear();
}
