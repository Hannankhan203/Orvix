/**
 * Orvix Client-Side Attachment Storage & Retrieval Service
 * Provides IndexedDB persistence for original file blobs, graceful availability checks,
 * in-browser previews for supported formats (PDF, text, markdown, images), and downloads.
 */

const DB_NAME = 'orvix_attachments_db';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

let dbPromise = null;

/**
 * Initializes and returns the IndexedDB database instance
 * @returns {Promise<IDBDatabase|null>}
 */
function getDB() {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (err) => {
        console.warn('[Attachment Storage] IndexedDB open error:', err);
        resolve(null);
      };
    } catch (e) {
      console.warn('[Attachment Storage] IndexedDB unsupported or blocked:', e);
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * Saves a file Blob/File to browser IndexedDB storage for offline & persistent message access.
 * @param {string} id - Stable attachment UUID
 * @param {Blob|File} fileOrBlob - The actual binary file data
 * @param {Object} [metadata={}] - File metadata (name, size, type, etc.)
 * @returns {Promise<boolean>}
 */
export async function saveAttachmentBlob(id, fileOrBlob, metadata = {}) {
  if (!id || !fileOrBlob) return false;

  try {
    const db = await getDB();
    if (!db) return false;

    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const record = {
        id,
        name: metadata.name || metadata.originalName || fileOrBlob.name || 'document',
        originalName: metadata.originalName || metadata.name || fileOrBlob.name || 'document',
        size: metadata.size || fileOrBlob.size || 0,
        formattedSize: metadata.formattedSize || '',
        type: metadata.type || metadata.mimeType || fileOrBlob.type || 'application/octet-stream',
        extension: metadata.extension || '',
        conversationId: metadata.conversationId || null,
        createdAt: Date.now(),
        blob: fileOrBlob
      };

      const putRequest = store.put(record);

      putRequest.onsuccess = () => resolve(true);
      putRequest.onerror = (err) => {
        console.warn('[Attachment Storage] Failed to store attachment in IndexedDB:', err);
        resolve(false);
      };
    });
  } catch (err) {
    console.warn('[Attachment Storage] saveAttachmentBlob error:', err);
    return false;
  }
}

/**
 * Retrieves a stored attachment record and its binary Blob from IndexedDB
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getAttachmentRecord(id) {
  if (!id) return null;

  try {
    const db = await getDB();
    if (!db) return null;

    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        resolve(getRequest.result || null);
      };

      getRequest.onerror = () => {
        resolve(null);
      };
    });
  } catch (err) {
    console.warn('[Attachment Storage] getAttachmentRecord error:', err);
    return null;
  }
}

/**
 * Checks whether an attachment is available either in browser IndexedDB or on the backend server.
 * @param {Object} attachment
 * @returns {Promise<{ available: boolean, source?: 'indexeddb' | 'server', reason?: string }>}
 */
export async function checkAttachmentStatus(attachment) {
  if (!attachment || !attachment.id) {
    return { available: false, reason: 'invalid_attachment' };
  }

  // 0. Check in-memory Blob or direct dataUrl
  if (attachment.file instanceof Blob || (typeof (attachment.previewUrl || attachment.dataUrl) === 'string' && (attachment.previewUrl || attachment.dataUrl).startsWith('data:'))) {
    return { available: true, source: 'memory' };
  }

  // 1. Check local IndexedDB first (near-instantaneous)
  const localRecord = await getAttachmentRecord(attachment.id);
  if (localRecord && localRecord.blob) {
    return { available: true, source: 'indexeddb', record: localRecord };
  }

  // 2. Check server upload registry
  try {
    const res = await fetch(`/api/upload/${attachment.id}`, { method: 'GET' });
    if (res.ok) {
      return { available: true, source: 'server' };
    }
    if (res.status === 404) {
      return { available: false, reason: 'expired' };
    }
  } catch (e) {
    // If network check fails, fallback to unavailable
  }

  return { available: false, reason: 'unavailable' };
}

/**
 * Determines whether a file format can be natively rendered / previewed in the browser.
 * @param {string} [extension='']
 * @param {string} [mimeType='']
 * @returns {boolean}
 */
export function isFormatPreviewable(extension = '', mimeType = '') {
  const ext = (extension || '').replace('.', '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  const previewableExts = ['pdf', 'txt', 'md', 'markdown', 'json', 'xml', 'csv', 'tsv', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif', 'svg'];
  if (previewableExts.includes(ext)) return true;

  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.startsWith('image/') ||
    mime === 'application/json' ||
    mime === 'application/xml'
  ) {
    return true;
  }

  return false;
}

/**
 * Opens an attachment in a new browser tab for preview if supported,
 * or triggers a direct download if the format is not previewable.
 * @param {Object} attachment
 * @returns {Promise<{ success: boolean, action: 'preview' | 'download' | 'unavailable', error?: string }>}
 */
export async function openOrPreviewAttachment(attachment) {
  if (!attachment || !attachment.id) {
    return { success: false, action: 'unavailable', error: 'Missing attachment ID.' };
  }

  const filename = attachment.name || attachment.originalName || 'document';
  const ext = attachment.extension || '';
  const mime = attachment.type || attachment.mimeType || '';
  const canPreview = isFormatPreviewable(ext, mime);

  // 0. Check in-memory File or Blob
  if (attachment.file instanceof Blob) {
    const blobUrl = URL.createObjectURL(attachment.file);
    if (canPreview) {
      const win = window.open(blobUrl, '_blank');
      if (win) {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return { success: true, action: 'preview' };
      }
    }
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true, action: 'download' };
  }

  // Direct dataUrl or previewUrl
  const directDataUri = attachment.previewUrl || attachment.dataUrl;
  if (typeof directDataUri === 'string' && (directDataUri.startsWith('data:') || directDataUri.startsWith('blob:'))) {
    if (canPreview) {
      const win = window.open(directDataUri, '_blank');
      if (win) return { success: true, action: 'preview' };
    }
    const link = document.createElement('a');
    link.href = directDataUri;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true, action: 'download' };
  }

  // 1. Check IndexedDB
  const localRecord = await getAttachmentRecord(attachment.id);
  if (localRecord && localRecord.blob) {
    const blobUrl = URL.createObjectURL(localRecord.blob);

    if (canPreview) {
      const win = window.open(blobUrl, '_blank');
      if (win) {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return { success: true, action: 'preview' };
      }
    }

    // Direct download if preview is not supported or popup blocked
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true, action: 'download' };
  }

  // 2. Fetch from backend server
  try {
    const endpoint = canPreview
      ? `/api/upload/${attachment.id}/file`
      : `/api/upload/${attachment.id}/download`;

    // Test availability first
    const checkRes = await fetch(`/api/upload/${attachment.id}`, { method: 'GET' });
    if (!checkRes.ok) {
      return {
        success: false,
        action: 'unavailable',
        error: 'This attachment has expired or is no longer stored on the server.'
      };
    }

    if (canPreview) {
      try {
        const win = window.open(endpoint, '_blank');
        if (win) {
          return { success: true, action: 'preview' };
        }
      } catch (_) {}
    }
    const link = document.createElement('a');
    link.href = endpoint;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true, action: 'download' };
  } catch (err) {
    console.warn('[Attachment Storage] openOrPreviewAttachment error:', err);
    return {
      success: false,
      action: 'unavailable',
      error: 'Unable to open attachment due to a network error.'
    };
  }
}

/**
 * Downloads the original attachment file with its exact original filename.
 * @param {Object} attachment
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function downloadAttachmentFile(attachment) {
  if (!attachment || !attachment.id) {
    return { success: false, error: 'Missing attachment ID.' };
  }

  const filename = attachment.name || attachment.originalName || 'download';

  // 0. Check in-memory Blob
  if (attachment.file instanceof Blob) {
    const blobUrl = URL.createObjectURL(attachment.file);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true };
  }

  // Direct dataUrl or previewUrl
  const directDataUri = attachment.previewUrl || attachment.dataUrl;
  if (typeof directDataUri === 'string' && (directDataUri.startsWith('data:') || directDataUri.startsWith('blob:'))) {
    const link = document.createElement('a');
    link.href = directDataUri;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true };
  }

  // 1. Check IndexedDB
  const localRecord = await getAttachmentRecord(attachment.id);
  if (localRecord && localRecord.blob) {
    const blobUrl = URL.createObjectURL(localRecord.blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { success: true };
  }

  // 2. Use server download endpoint
  try {
    const endpoint = `/api/upload/${attachment.id}/download`;
    const checkRes = await fetch(`/api/upload/${attachment.id}`, { method: 'GET' });
    if (!checkRes.ok) {
      // If server does not have the binary but extraction text is available for textual document
      if (attachment.extraction?.text) {
        const textBlob = new Blob([attachment.extraction.text], { type: 'text/plain;charset=utf-8' });
        const textUrl = URL.createObjectURL(textBlob);
        const link = document.createElement('a');
        link.href = textUrl;
        link.download = filename.endsWith('.txt') ? filename : `${filename}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(textUrl), 10000);
        return { success: true };
      }

      return {
        success: false,
        error: 'This attachment has expired or is no longer stored on the server.'
      };
    }

    const link = document.createElement('a');
    link.href = endpoint;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: 'Unable to download attachment due to a network error.'
    };
  }
}
