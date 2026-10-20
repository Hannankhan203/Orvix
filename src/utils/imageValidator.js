/**
 * Orvix Image Validator & Processing Utility
 * Validates file MIME types, extensions, magic numbers, decodability, and dimensions.
 * Creates local object URLs for previews with explicit lifecycle management.
 * Provides batch validation and base64 encoding for API transport.
 */

import { formatFileSize } from './documentExtractor.js';

export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp'
];

export const SUPPORTED_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp'
];

// 5 MB maximum per image (stays well within Express limit accounting for ~33% base64 expansion)
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMAGE_COUNT = 3;
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB total batch limit

/**
 * Extracts file extension in lowercase including dot (e.g. '.png')
 * @param {string} filename
 * @returns {string}
 */
export function getImageExtension(filename = '') {
  const idx = filename.lastIndexOf('.');
  return idx !== -1 ? filename.slice(idx).toLowerCase() : '';
}

/**
 * Checks whether a given file is an image by extension or MIME type
 * @param {File|Blob|{ name?: string, type?: string }} file
 * @returns {boolean}
 */
export function isImageFile(file) {
  if (!file) return false;
  const ext = getImageExtension(file.name || '');
  if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext) || ext === '.gif') return true;
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
  return false;
}

/**
 * Checks file header magic bytes to verify actual image format
 * (Prevents renamed non-image files or executable masquerades)
 *
 * @param {ArrayBuffer} buffer - First few bytes of file
 * @returns {'png' | 'jpeg' | 'webp' | 'gif' | 'unknown'}
 */
export function detectImageMagicBytes(buffer) {
  if (!buffer || buffer.byteLength < 12) {
    return 'unknown';
  }

  const bytes = new Uint8Array(buffer.slice(0, 16));

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }

  // JPEG / JPG: FF D8 FF
  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'jpeg';
  }

  // WebP: RIFF .... WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }

  // GIF: GIF87a / GIF89a (detected so we can explicitly reject)
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'gif';
  }

  return 'unknown';
}

/**
 * Synchronously checks superficial constraints (existence, empty file, extension, size)
 *
 * @param {File} file
 * @param {number} [existingCount=0]
 * @returns {string | null} Validation error message or null if valid
 */
export function validateImageFile(file, existingCount = 0) {
  if (!file) {
    return 'No file selected.';
  }

  if (file.size === 0) {
    return `File "${file.name}" is empty (0 bytes). Please upload a valid image.`;
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return `File "${file.name}" (${formatFileSize(file.size)}) exceeds the maximum allowed image size of ${formatFileSize(MAX_IMAGE_SIZE_BYTES)}.`;
  }

  const ext = getImageExtension(file.name);

  // Check if file is a GIF
  if (ext === '.gif' || file.type === 'image/gif') {
    return `GIF images (including animated GIFs) are not supported. Please upload a PNG, JPEG, or WebP image.`;
  }

  const isValidExt = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
  const isValidMime = typeof file.type === 'string' && SUPPORTED_IMAGE_TYPES.includes(file.type);

  if (!isValidExt && !isValidMime) {
    return `Unsupported image format "${ext || file.type || 'unknown'}". Supported image formats are PNG (.png), JPEG (.jpg, .jpeg), and WebP (.webp).`;
  }

  if (existingCount >= MAX_IMAGE_COUNT) {
    return `You can attach up to ${MAX_IMAGE_COUNT} images per message. Please remove an image before adding another.`;
  }

  return null;
}

/**
 * Asynchronously decodes an image file, validates magic bytes, reads dimensions,
 * and converts to base64 for API transport.
 *
 * @param {File} file
 * @returns {Promise<{
 *   id: string,
 *   category: 'image',
 *   name: string,
 *   size: number,
 *   type: string,
 *   mimeType: string,
 *   width: number,
 *   height: number,
 *   previewUrl: string,
 *   dataUrl: string,
 *   base64: string,
 *   status: 'ready',
 *   displaySize: string,
 *   file: File
 * }>}
 */
export async function decodeAndProcessImage(file) {
  const syncError = validateImageFile(file);
  if (syncError) {
    throw new Error(syncError);
  }

  // 1. Read first 32 bytes to inspect magic numbers
  const sliceBuffer = await file.slice(0, 32).arrayBuffer();
  const detectedFormat = detectImageMagicBytes(sliceBuffer);

  if (detectedFormat === 'gif') {
    throw new Error(
      `GIF images (including animated GIFs) are not supported. Please upload a PNG, JPEG, or WebP image.`
    );
  }

  if (detectedFormat === 'unknown') {
    throw new Error(
      `File "${file.name}" does not match recognized PNG, JPEG, or WebP image signatures. The file may be corrupted or disguised.`
    );
  }

  // Normalize mime type based on detected format
  const mimeType =
    detectedFormat === 'png'
      ? 'image/png'
      : detectedFormat === 'jpeg'
      ? 'image/jpeg'
      : 'image/webp';

  // 2. Create local object URL for preview and browser decoding
  const previewUrl = URL.createObjectURL(file);

  // 3. Verify the image can actually be decoded and has non-zero dimensions
  const dimensions = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        URL.revokeObjectURL(previewUrl);
        reject(
          new Error(`Image "${file.name}" has invalid dimensions (0x0). It may be corrupted.`)
        );
      } else {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight
        });
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(previewUrl);
      reject(
        new Error(
          `Failed to decode "${file.name}". The image file is corrupted or unreadable by your browser.`
        )
      );
    };
    img.src = previewUrl;
  });

  // 4. Read full file as base64 data URL for API transmission
  const dataUrl = await readFileAsDataUrl(file);
  const base64PrefixMatch = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  const base64 = base64PrefixMatch ? base64PrefixMatch[2] : '';

  const id = `img-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  return {
    id,
    category: 'image',
    name: file.name,
    size: file.size,
    type: mimeType,
    mimeType,
    width: dimensions.width,
    height: dimensions.height,
    previewUrl,
    dataUrl,
    base64,
    status: 'ready',
    displaySize: formatFileSize(file.size),
    file
  };
}

/**
 * Validates and processes a batch of image files concurrently with slot and total size checks
 *
 * @param {File[]} files - List of selected or dropped files
 * @param {Array<Object>} [existingAttachments=[]] - Already staged attachments
 * @returns {Promise<{ validImages: Array<Object>, errors: string[] }>}
 */
export async function processImageBatch(files = [], existingAttachments = []) {
  const currentImages = existingAttachments.filter(
    (att) => att?.category === 'image' || att?.type?.startsWith('image/')
  );

  let availableSlots = MAX_IMAGE_COUNT - currentImages.length;
  const currentTotalBytes = currentImages.reduce((sum, att) => sum + (att.size || 0), 0);
  let runningTotalBytes = currentTotalBytes;

  const validImages = [];
  const errors = [];

  for (const file of files) {
    if (availableSlots <= 0) {
      errors.push(`Maximum of ${MAX_IMAGE_COUNT} images per message reached. Could not attach "${file.name}".`);
      continue;
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      errors.push(
        `File "${file.name}" (${formatFileSize(file.size)}) exceeds the maximum allowed image size of ${formatFileSize(MAX_IMAGE_SIZE_BYTES)}.`
      );
      continue;
    }

    if (runningTotalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
      errors.push(
        `File "${file.name}" (${formatFileSize(file.size)}) would exceed the total image batch limit of ${formatFileSize(MAX_TOTAL_IMAGE_BYTES)}.`
      );
      continue;
    }

    try {
      const processed = await decodeAndProcessImage(file);
      validImages.push(processed);
      availableSlots--;
      runningTotalBytes += file.size;
    } catch (err) {
      errors.push(err.message || `Failed to process image "${file.name}".`);
    }
  }

  return { validImages, errors };
}

/**
 * Safely revokes an object URL if it is a valid blob URL
 * @param {string} url
 */
export function revokeImageUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }
}

/**
 * Reads a File / Blob as a base64 Data URL
 * @param {File | Blob} blob
 * @returns {Promise<string>}
 */
function readFileAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error('Failed to encode image data for transmission.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Normalizes an array of staged or processed image attachments into a clean payload
 * for API transmission, ensuring no duplicate base64 strings or non-serializable DOM objects.
 *
 * @param {Array<Object>} images
 * @returns {Array<{ id: string, name: string, size: number, type: string, mimeType: string, width: number, height: number, base64: string }>}
 */
export function formatImagePayload(images = []) {
  if (!Array.isArray(images) || images.length === 0) return [];
  return images.map((img, index) => {
    let cleanBase64 = img.base64 || '';
    if (!cleanBase64 && typeof img.dataUrl === 'string') {
      const match = img.dataUrl.match(/^data:[^;]+;base64,(.*)$/);
      cleanBase64 = match ? match[1] : '';
    }

    const mime = img.mimeType || img.type || 'image/png';

    return {
      id: img.id || `img-${index}`,
      name: img.name || `image-${index + 1}`,
      size: Number(img.size) || 0,
      type: mime,
      mimeType: mime,
      width: img.width || 0,
      height: img.height || 0,
      base64: cleanBase64
    };
  });
}

