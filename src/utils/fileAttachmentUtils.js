/**
 * File Attachment Utility Functions
 * Provides file type verification, extension extraction, safe formatting,
 * and metadata generation for chat attachments in Orvix.
 */

export const SUPPORTED_ATTACHMENT_EXTENSIONS = [
  'pdf',
  'docx',
  'doc',
  'txt',
  'md',
  'markdown',
  'ppt',
  'pptx',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml'
];

export const ATTACHMENT_ACCEPT_STRING =
  '.pdf,.docx,.doc,.txt,.md,.markdown,.ppt,.pptx,.csv,.json,.xml,.yaml,.yml';

/**
 * Formats byte count into a human-readable size string (e.g. 512 B, 42.5 KB, 3.2 MB)
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/**
 * Extracts and normalizes the uppercase extension from a filename
 * @param {string} filename
 * @returns {string}
 */
export function getFileExtension(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) return '';
  return filename.slice(lastDot + 1).toUpperCase();
}

/**
 * Creates a clean, safe attachment metadata object from a DOM File instance
 * @param {File} file
 * @param {number} [index=0]
 * @returns {Object}
 */
export function createAttachmentMetadata(file, index = 0) {
  const extension = getFileExtension(file.name);
  const uniqueId = `att-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id: uniqueId,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    extension: extension || 'FILE',
    lastModified: file.lastModified || Date.now(),
    // Keep reference to raw file in memory for downstream processing
    rawFile: file
  };
}
