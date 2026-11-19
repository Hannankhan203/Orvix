/**
 * Orvix Dedicated PDF Text Extraction Web Worker
 * Lazily loads unpdf (serverless PDF.js, ~1.67 MB) completely off the main UI thread
 * so PDF parsing neither blocks rendering nor bloats the main bundle.
 */

self.onmessage = async (event) => {
  const payload = event?.data || {};
  const id = payload.id;
  try {
    const { extractText } = await import('unpdf');
    const uint8Array =
      payload.buffer instanceof Uint8Array
        ? payload.buffer
        : new Uint8Array(payload.buffer);
    const res = await extractText(uint8Array, { mergePages: false });
    self.postMessage({
      id,
      ok: true,
      totalPages: res?.totalPages,
      text: res?.text
    });
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    self.postMessage({
      id,
      ok: false,
      errorName: anyErr?.name ? String(anyErr.name) : 'Error',
      errorMessage: anyErr?.message ? String(anyErr.message) : String(anyErr || 'PDF extraction error')
    });
  }
};
