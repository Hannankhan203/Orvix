import { PROVIDER_OPTIONS } from '../../services/aiRouter.js';
import { PROVIDER_DEFAULT_MODELS } from '../../services/providerModelSanitizer.js';
import { WEBLLM_MODEL_CATALOG, DEFAULT_WEBLLM_MODEL_ID } from '../../services/webllmService.js';

export function formatGeminiModelDisplayName(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return '';
  return modelId
    .trim()
    .replace(/^models\//i, '')
    .split('-')
    .filter(Boolean)
    .map((segment) =>
      /^[a-z]/i.test(segment)
        ? segment.charAt(0).toUpperCase() + segment.slice(1)
        : segment
    )
    .join(' ');
}

export function getGeminiFootnote() {
  const geminiOption = Array.isArray(PROVIDER_OPTIONS)
    ? PROVIDER_OPTIONS.find((p) => p.id === 'gemini')
    : null;
  const configuredModelId =
    PROVIDER_DEFAULT_MODELS?.gemini || geminiOption?.defaultModel || '';
  const modelLabel =
    (geminiOption?.modelTag &&
    (!configuredModelId || geminiOption.defaultModel === configuredModelId)
      ? geminiOption.modelTag
      : formatGeminiModelDisplayName(configuredModelId)) ||
    geminiOption?.modelTag ||
    'Gemini';
  return `Orvix is powered by Google Gemini (${modelLabel}). Client integration — verify important facts independently.`;
}

export function getProviderFootnote(providerId, webllmModelId = DEFAULT_WEBLLM_MODEL_ID) {
  if (providerId === 'webllm') {
    const modelLabel =
      WEBLLM_MODEL_CATALOG[webllmModelId]?.shortLabel || 'Qwen 2.5 1.5B';
    return `Orvix is powered by Browser AI (WebLLM) (${modelLabel}). On-device WebGPU inference — verify important facts independently.`;
  }
  if (providerId === 'groq') {
    return 'Orvix is powered by Groq (GPT OSS 120B). Ultra-fast inference — verify important facts independently.';
  }
  if (providerId === 'openrouter') {
    const openrouterOption = Array.isArray(PROVIDER_OPTIONS)
      ? PROVIDER_OPTIONS.find((p) => p.id === 'openrouter')
      : null;
    const modelLabel = openrouterOption?.modelTag || 'Free Models Router';
    return `Orvix is powered by OpenRouter (${modelLabel}), dynamically selecting from available free community models.`;
  }
  if (providerId === 'cloudflare') {
    return 'Orvix is powered by Cloudflare Workers AI (Llama 3.1 8B). Serverless inference — verify important facts independently.';
  }
  if (providerId === 'gemini') {
    return getGeminiFootnote();
  }
  const config = Array.isArray(PROVIDER_OPTIONS) ? PROVIDER_OPTIONS.find((p) => p.id === providerId) : null;
  if (config) {
    const model = config.defaultModel || config.modelTag || 'AI Model';
    return `Orvix is powered by ${config.name} (${model}). ${config.description || 'Inference'} — verify important facts independently.`;
  }
  return getGeminiFootnote();
}

// Whitelist of supported image extensions
export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  'JPG',
  'JPEG',
  'PNG',
  'WEBP',
  'GIF',
  'BMP',
  'HEIC',
  'HEIF'
]);

// Whitelist of all supported file extensions (consistent with server upload whitelists)
export const SUPPORTED_EXTENSIONS = new Set([
  'PDF',
  'DOCX',
  'DOC',
  'PPTX',
  'PPT',
  'XLSX',
  'XLS',
  'TXT',
  'MD',
  'MARKDOWN',
  'CSV',
  'TSV',
  'JSON',
  'XML',
  'JPG',
  'JPEG',
  'PNG',
  'WEBP',
  'GIF',
  'BMP',
  'HEIC',
  'HEIF'
]);

// Helper to determine the standard extension from MIME type
export function getExtensionFromMime(mimeType) {
  if (!mimeType) return null;
  const mime = mimeType.toLowerCase();
  if (mime.includes('png')) return 'PNG';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'JPG';
  if (mime.includes('webp')) return 'WEBP';
  if (mime.includes('gif')) return 'GIF';
  if (mime.includes('bmp')) return 'BMP';
  if (mime.includes('heic')) return 'HEIC';
  if (mime.includes('heif')) return 'HEIF';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('wordprocessingml') || mime.includes('docx')) return 'DOCX';
  if (mime.includes('msword')) return 'DOC';
  if (mime.includes('presentationml') || mime.includes('pptx')) return 'PPTX';
  if (mime.includes('ms-powerpoint')) return 'PPT';
  if (mime.includes('spreadsheetml') || mime.includes('xlsx')) return 'XLSX';
  if (mime.includes('ms-excel')) return 'XLS';
  if (mime.includes('json')) return 'JSON';
  if (mime.includes('csv')) return 'CSV';
  if (mime.includes('markdown')) return 'MD';
  if (mime.includes('plain')) return 'TXT';
  if (mime.includes('xml')) return 'XML';
  return null;
}

// Helper to resolve a sensible filename for clipboard pasted files where browser doesn't provide one
export function resolvePastedFileName(rawFile) {
  const mimeType = (rawFile.type || '').toLowerCase();
  const rawName = (rawFile.name || '').trim();

  // If the browser provided a specific, non-generic filename with an extension, preserve it
  const hasSpecificName =
    rawName &&
    rawName !== 'image.png' &&
    rawName !== 'blob' &&
    rawName !== 'file' &&
    rawName.includes('.');

  if (hasSpecificName) {
    return rawName;
  }

  // Derive extension from mime type
  const mimeExt = getExtensionFromMime(mimeType);
  let ext = (mimeExt || 'png').toLowerCase();

  const isImage = mimeType.startsWith('image/') || SUPPORTED_IMAGE_EXTENSIONS.has(ext.toUpperCase());
  const prefix = isImage ? 'pasted-image' : 'pasted-file';
  return `${prefix}.${ext}`;
}

// Helper to detect if a drag event involves external files (and not dragged text/elements)
export function isFileDragEvent(e) {
  if (!e.dataTransfer || !e.dataTransfer.types) return false;
  const types = e.dataTransfer.types;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') {
      return true;
    }
  }
  return false;
}

export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}
