import { auth } from '../config/firebaseConfig.js';
import { saveAttachmentBlob } from './attachmentStorageService.js';

/**
 * Service to request image generation from the authenticated server endpoint.
 */
export async function generateImage({
  prompt,
  provider = 'auto',
  model,
  aspectRatio = '1:1',
  conversationId,
  signal = null
}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('A descriptive text prompt is required to generate an image.');
  }

  const trimmed = prompt.trim();
  const headers = {
    'Content-Type': 'application/json'
  };

  // Attach Firebase ID token if user is signed in
  try {
    if (auth?.currentUser) {
      const idToken = await auth.currentUser.getIdToken();
      if (idToken) {
        headers['Authorization'] = `Bearer ${idToken}`;
      }
    }
  } catch (tokenErr) {
    console.warn('[ImageService] Error resolving user token:', tokenErr);
  }

  const controller = new AbortController();
  const onSignalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onSignalAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    controller.abort(new Error('Image generation timed out after 60 seconds.'));
  }, 60000);

  try {
    const res = await fetch('/api/generate-image', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: trimmed,
        provider,
        model,
        aspectRatio,
        conversationId
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error(`Server returned HTTP ${res.status} without a JSON response.`);
    }

    if (!res.ok || !data.success) {
      const errorMsg = data?.error || `Image generation failed (HTTP ${res.status})`;
      const err = new Error(errorMsg);
      err.code = data?.code || (res.status === 401 ? 'UNAUTHORIZED' : res.status === 429 ? 'QUOTA_EXCEEDED' : res.status === 503 ? 'PROVIDER_UNAVAILABLE' : 'GENERATION_ERROR');
      err.status = res.status;
      err.provider = data?.provider;
      err.retryable = Boolean(data?.retryable);
      throw err;
    }

    // Attempt to cache in IndexedDB for seamless offline and reload persistence
    if (data.id && data.base64) {
      try {
        const byteCharacters = atob(data.base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: data.mimeType || 'image/png' });

        await saveAttachmentBlob(data.id, blob, {
          name: data.filename || `generated-${data.id}.png`,
          originalName: data.filename,
          mimeType: data.mimeType || 'image/png',
          size: data.size || blob.size,
          extension: `.${data.format || 'png'}`,
          isImage: true,
          conversationId: conversationId || null
        });
      } catch (cacheErr) {
        console.warn('[ImageService] Failed to cache generated image in IndexedDB:', cacheErr);
      }
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      const abortErr = new Error('Image generation request timed out. Upstream provider took too long to respond.');
      abortErr.code = 'DEADLINE_EXCEEDED';
      abortErr.status = 504;
      throw abortErr;
    }
    throw err;
  }
}

/**
 * Downloads a generated image in its original available format.
 */
export function downloadGeneratedImage(imageResult, preferredFilename) {
  if (!imageResult) return false;

  const dataUri = imageResult.dataUrl || (imageResult.base64 ? `data:${imageResult.mimeType || 'image/png'};base64,${imageResult.base64}` : null);
  const ext = imageResult.format ? `.${imageResult.format}` : (imageResult.filename ? imageResult.filename.substring(imageResult.filename.lastIndexOf('.')) : '.png');
  const filename = preferredFilename
    ? (preferredFilename.endsWith(ext) ? preferredFilename : `${preferredFilename}${ext}`)
    : imageResult.filename || `orvix-generated-${Date.now()}${ext}`;

  if (dataUri) {
    const link = document.createElement('a');
    link.href = dataUri;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return true;
  }

  // Fallback to URL if provided, or upload/image file endpoint by ID
  const chatIdParam = imageResult.conversationId ? `?chatId=${encodeURIComponent(imageResult.conversationId)}` : '';
  const fallbackUrl =
    imageResult.url ||
    (imageResult.id ? `/api/upload/${imageResult.id}/file${chatIdParam}` : null) ||
    (imageResult.id ? `/api/image/${imageResult.id}/download${chatIdParam}` : null);

  if (fallbackUrl) {
    const link = document.createElement('a');
    link.href = fallbackUrl;
    link.download = filename;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return true;
  }

  return false;
}
