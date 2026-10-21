/**
 * Orvix File Upload Service
 * Handles multipart file uploads to the backend upload endpoint.
 * Validates sizes and formats client-side, manages progress, and returns structured server metadata.
 */

import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  validateAttachmentFile
} from '../utils/fileAttachmentUtils.js';

/**
 * Uploads an array of DOM File instances to the backend using multipart/form-data.
 *
 * @param {File[]} files - Array of browser File objects to upload
 * @returns {Promise<Array<{ id: string, name: string, size: number, type: string, extension: string, status: string, uploadedAt: number }>>}
 */
export async function uploadAttachmentFiles(files = []) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(
      `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments allowed per message. Selected ${files.length}.`
    );
  }

  // Pre-validate all files before network dispatch
  for (const file of files) {
    const check = validateAttachmentFile(file);
    if (!check.isValid) {
      throw new Error(check.error || `Invalid file "${file.name}".`);
    }
  }

  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData
  });

  let responseData = null;
  try {
    responseData = await response.json();
  } catch (_) {
    throw new Error(`Upload server error (HTTP ${response.status}).`);
  }

  if (!response.ok || !responseData?.success) {
    const errorMsg =
      responseData?.error ||
      (response.status === 413
        ? 'File exceeds the maximum size limit of 10MB.'
        : response.status === 415
        ? 'Unsupported file type.'
        : `Upload failed (HTTP ${response.status}).`);
    const err = new Error(errorMsg);
    err.code = responseData?.code || response.status;
    throw err;
  }

  return responseData.attachments || [];
}

/**
 * Sends a cleanup request to remove a temporary attachment from the server storage.
 *
 * @param {string} attachmentId
 * @returns {Promise<void>}
 */
export async function deleteUploadedAttachment(attachmentId) {
  if (!attachmentId || typeof attachmentId !== 'string') return;
  try {
    await fetch(`/api/upload/${encodeURIComponent(attachmentId)}`, {
      method: 'DELETE'
    });
  } catch (err) {
    console.warn('Could not delete temporary upload:', err);
  }
}
