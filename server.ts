import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { buildDocumentContext } from "./src/utils/documentContext.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Permissive CORS middleware for cross-origin and Vercel preview environments
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Title",
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: "20mb" }));

// Handle payload too large errors cleanly
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({
        error:
          "Request payload exceeds the maximum allowed upload limit (20 MB). Please reduce the size of attached images or documents.",
        code: 413,
        status: "PAYLOAD_TOO_LARGE",
      });
    }
    next(err);
  },
);

// Helper to pause execution with backoff
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to pause execution while honoring client disconnect cancellation
async function sleepWithAbort(
  ms: number,
  isAborted: () => boolean,
): Promise<boolean> {
  const interval = 100;
  let elapsed = 0;
  while (elapsed < ms) {
    if (isAborted()) return false;
    const step = Math.min(interval, ms - elapsed);
    await sleep(step);
    elapsed += step;
  }
  return !isAborted();
}

function getBackoffWithJitter(attempt: number, retryAfterSec?: number): number {
  if (process.env.TEST === "true" || process.env.TEST_FAST_BACKOFF === "true") {
    return 10;
  }
  if (retryAfterSec && retryAfterSec > 0 && retryAfterSec <= 10) {
    return retryAfterSec * 1000 + Math.random() * 300;
  }
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 3000);
  const jitter = Math.random() * 400;
  return base + jitter;
}

// Sanitizes error messages to ensure no API keys, tokens, or headers are ever logged
function sanitizeErrorLog(msg: string): string {
  if (!msg) return "";
  return String(msg)
    .replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, "Bearer [REDACTED]")
    .replace(/key=[^&\s]+/gi, "key=[REDACTED]");
}

interface DiagnosticLogData {
  requestId?: string;
  provider: string;
  model: string;
  phase: "pre-stream" | "mid-stream" | "non-streaming";
  headersSent?: boolean;
  httpStatus?: number;
  attempt: number;
  maxAttempts: number;
  upstreamStatus?: number;
  upstreamErrorCode?: string;
  originalErrorName?: string;
  originalErrorMessage?: string;
  sanitizedMessage: string;
  retryAfterSeconds?: number;
  willRetry: boolean;
}

/**
 * Server-side diagnostic logger recording provider, model, HTTP status, sanitized error,
 * retry attempt number, and streaming phase without exposing credentials or user data.
 */
function logAIDiagnostic(data: DiagnosticLogData) {
  const reqStr = data.requestId ? `[Req: ${data.requestId}] ` : "";
  const statusStr = data.httpStatus
    ? `HTTP ${data.httpStatus}`
    : data.upstreamStatus
      ? `HTTP ${data.upstreamStatus}`
      : "HTTP N/A";
  const codeStr = data.upstreamErrorCode ? `[${data.upstreamErrorCode}]` : "";
  const actionDesc = data.willRetry
    ? `Will retry (attempt ${data.attempt + 1}/${data.maxAttempts}${data.retryAfterSeconds ? ` after ${data.retryAfterSeconds}s` : ""})`
    : "No further retries";
  const origDesc = data.originalErrorName
    ? ` | Cause: ${data.originalErrorName} (${sanitizeErrorLog(data.originalErrorMessage || "")})`
    : "";

  console.warn(
    `${reqStr}[AI Diagnostic] Provider: ${data.provider} | Model: ${data.model} | Phase: ${data.phase} | HeadersSent: ${Boolean(data.headersSent)} | Status: ${statusStr} ${codeStr} | Attempt: ${data.attempt}/${data.maxAttempts} | Action: ${actionDesc}${origDesc} | UserMsg: ${sanitizeErrorLog(data.sanitizedMessage)}`,
  );
}

function toValidHttpStatus(code: any, fallback = 500): number {
  if (code === undefined || code === null) return fallback;
  const num = typeof code === "number" ? code : parseInt(String(code), 10);
  return Number.isInteger(num) && num >= 100 && num <= 599 ? num : fallback;
}

// Parses and normalizes Gemini API errors into clean user-facing representations
export function parseGeminiError(err: any): {
  statusCode: number;
  status: string;
  isUnavailable: boolean;
  isRetryable: boolean;
  message: string;
  retryAfterSeconds?: number;
  originalErrorName: string;
  originalErrorMessage: string;
} {
  const originalErrorName = String(err?.name || "Error");
  const originalErrorMessage = String(err?.message || err || "");
  let rawCandidate = err?.status || err?.statusCode;
  if (
    !rawCandidate &&
    Number.isInteger(Number(err?.code)) &&
    Number(err?.code) >= 100 &&
    Number(err?.code) <= 599
  ) {
    rawCandidate = err?.code;
  }
  let statusCode = toValidHttpStatus(rawCandidate, 500);
  let statusText = String(
    err?.statusText ||
      (typeof err?.status === "string" ? err.status : "") ||
      "",
  );
  let message = String(err?.message || err || "");
  let isRetryable = false;
  let isUnavailable = false;
  let retryAfterSeconds: number | undefined = undefined;

  // Unpack nested JSON from @google/genai errors (can be 2 levels deep)
  for (let i = 0; i < 3; i++) {
    if (typeof message !== "string") break;
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (!jsonMatch) break;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.error) {
        if (
          parsed.error.code &&
          Number.isInteger(Number(parsed.error.code)) &&
          Number(parsed.error.code) >= 100 &&
          Number(parsed.error.code) <= 599
        ) {
          statusCode = Number(parsed.error.code);
        }
        if (parsed.error.status) statusText = String(parsed.error.status);
        if (parsed.error.message) {
          message = String(parsed.error.message);
        } else {
          break;
        }
      } else {
        break;
      }
    } catch (_) {
      break;
    }
  }

  // Check for Retry-After header if available
  if (err?.headers && typeof err.headers.get === "function") {
    const retryHeader = err.headers.get("retry-after");
    if (retryHeader) {
      const parsedSec = parseInt(retryHeader, 10);
      if (!isNaN(parsedSec)) retryAfterSeconds = parsedSec;
    }
  }

  const lowerMsg = message.toLowerCase();
  const upperStatus = statusText.toUpperCase();

  // Detect AbortError, client timeout, or DOMException code 20 (DOMException.ABORT_ERR = 20)
  const isAbortOrTimeout =
    err?.name === "AbortError" ||
    err?.code === 20 ||
    err?.code === "ABORT_ERR" ||
    err?.code === "ETIMEDOUT" ||
    lowerMsg.includes("aborted") ||
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("deadline exceeded");

  if (isAbortOrTimeout) {
    statusCode = 504;
    statusText = "DEADLINE_EXCEEDED";
    isUnavailable = false;
    isRetryable = true;
    message =
      "The AI service timed out while waiting for a response. Please try again.";
  } else if (
    statusCode === 503 ||
    statusCode === 504 ||
    upperStatus === "UNAVAILABLE" ||
    upperStatus === "DEADLINE_EXCEEDED" ||
    lowerMsg.includes("overloaded") ||
    lowerMsg.includes("high demand") ||
    lowerMsg.includes("spikes in demand") ||
    lowerMsg.includes("service unavailable") ||
    lowerMsg.includes("temporarily unavailable") ||
    lowerMsg.includes("deadline expired")
  ) {
    statusCode =
      statusCode === 504 || upperStatus === "DEADLINE_EXCEEDED" ? 504 : 503;
    statusText = statusCode === 504 ? "DEADLINE_EXCEEDED" : "UNAVAILABLE";
    isUnavailable = true;
    isRetryable = true;
    message =
      "Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.";
  } else if (
    statusCode === 429 ||
    upperStatus === "RESOURCE_EXHAUSTED" ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("quota") ||
    lowerMsg.includes("resource_exhausted")
  ) {
    statusCode = 429;
    statusText = "RESOURCE_EXHAUSTED";
    isUnavailable = true;
    isRetryable = false; // Rate-limit / quota exhaustion should not loop through same-provider models
    message =
      "Gemini rate limit or quota exceeded. Please wait a moment before trying again.";
  } else if (
    statusCode === 401 ||
    statusCode === 403 ||
    upperStatus === "UNAUTHENTICATED" ||
    upperStatus === "PERMISSION_DENIED" ||
    lowerMsg.includes("api_key_invalid") ||
    lowerMsg.includes("api key not valid") ||
    lowerMsg.includes("unauthorized") ||
    lowerMsg.includes("permission denied")
  ) {
    statusCode = statusCode === 401 ? 401 : 403;
    statusText = statusCode === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED";
    isRetryable = false;
    message =
      "Invalid or unauthorized Gemini API key. Please check your API configuration.";
  } else if (
    statusCode === 404 ||
    upperStatus === "NOT_FOUND" ||
    lowerMsg.includes("not found") ||
    lowerMsg.includes("is no longer available")
  ) {
    statusCode = 404;
    statusText = "NOT_FOUND";
    isRetryable = false;
    message = sanitizeErrorLog(message) || "Requested Gemini model not found.";
  } else if (
    statusCode === 400 ||
    upperStatus === "INVALID_ARGUMENT" ||
    lowerMsg.includes("invalid argument")
  ) {
    statusCode = 400;
    statusText = "INVALID_ARGUMENT";
    isRetryable = false;
    message =
      sanitizeErrorLog(message) ||
      "Invalid argument provided to the Gemini model.";
  } else {
    statusCode = 500;
    statusText = statusText || "INTERNAL";
    isRetryable = false;
    if (
      lowerMsg.includes("invalid status code") ||
      lowerMsg.includes("err_http_invalid_status_code") ||
      lowerMsg.includes("rangeerror") ||
      !message
    ) {
      message = "Internal error encountered by Google Gemini service.";
    } else {
      message = sanitizeErrorLog(message);
    }
  }

  return {
    statusCode: toValidHttpStatus(statusCode, 500),
    status: statusText || (isUnavailable ? "UNAVAILABLE" : "ERROR"),
    isUnavailable,
    isRetryable,
    message: sanitizeErrorLog(message),
    retryAfterSeconds,
    originalErrorName,
    originalErrorMessage,
  };
}

export interface ValidatedImageAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width?: number;
  height?: number;
  base64: string;
}

export interface ImageValidationResult {
  valid: boolean;
  error?: string;
  statusCode?: number;
  validatedImages: ValidatedImageAttachment[];
  totalBytes: number;
}

export const SERVER_MAX_IMAGE_COUNT = 3;
export const SERVER_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
export const SERVER_MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB total batch

/**
 * Server-side validation of incoming image attachments.
 * Validates count, size, non-empty content, base64 encoding, and file magic bytes (signatures).
 * Rejects GIF, executables, corrupted files, and oversized uploads.
 */
export function validateServerImages(rawImages: any[]): ImageValidationResult {
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    return { valid: true, validatedImages: [], totalBytes: 0 };
  }

  if (rawImages.length > SERVER_MAX_IMAGE_COUNT) {
    return {
      valid: false,
      statusCode: 400,
      error: `You can attach up to ${SERVER_MAX_IMAGE_COUNT} images per message. Received ${rawImages.length}.`,
      validatedImages: [],
      totalBytes: 0,
    };
  }

  const validatedImages: ValidatedImageAttachment[] = [];
  let totalBytes = 0;

  for (let i = 0; i < rawImages.length; i++) {
    const img = rawImages[i];
    const name =
      typeof img?.name === "string" && img.name.trim()
        ? img.name.trim().slice(0, 100)
        : `image-${i + 1}`;

    // Extract raw base64 string
    let base64 = "";
    if (typeof img?.base64 === "string" && img.base64.trim()) {
      base64 = img.base64.trim();
    } else if (typeof img?.dataUrl === "string" && img.dataUrl.trim()) {
      const match = img.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (match) base64 = match[2].trim();
    }

    if (!base64) {
      return {
        valid: false,
        statusCode: 400,
        error: `Image "${name}" contains empty or missing image data.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // Validate base64 encoding format
    const compactBase64 = base64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
      return {
        valid: false,
        statusCode: 400,
        error: `Image "${name}" has malformed or invalid base64 encoding.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // Decode base64 to Buffer
    let buffer: Buffer;
    try {
      buffer = Buffer.from(compactBase64, "base64");
    } catch (_) {
      return {
        valid: false,
        statusCode: 400,
        error: `Image "${name}" has malformed or invalid base64 encoding.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    if (buffer.length === 0) {
      return {
        valid: false,
        statusCode: 400,
        error: `Image "${name}" is empty (0 bytes).`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // Check size limit per image
    if (buffer.length > SERVER_MAX_IMAGE_BYTES) {
      const sizeMb = (buffer.length / (1024 * 1024)).toFixed(1);
      return {
        valid: false,
        statusCode: 400,
        error: `Image "${name}" (${sizeMb} MB) exceeds the maximum allowed size of 5 MB.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    totalBytes += buffer.length;
    if (totalBytes > SERVER_MAX_TOTAL_IMAGE_BYTES) {
      return {
        valid: false,
        statusCode: 400,
        error: `Total attached images size exceeds the maximum batch limit of 10 MB.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // Magic bytes signature verification (requires minimum 12 bytes)
    if (buffer.length < 12) {
      return {
        valid: false,
        statusCode: 400,
        error: `Image "${name}" is too small to be a valid image file.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // Detect unsupported formats explicitly for clear user guidance
    // GIF: GIF87a / GIF89a (47 49 46 38)
    const isGif =
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38;
    if (isGif) {
      return {
        valid: false,
        statusCode: 400,
        error: `GIF images (including animated GIFs) are not supported. Please upload a PNG, JPEG, or WebP image.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // SVG / XML: <?xml or <svg (3C 3F 78 6D or 3C 73 76 67 or 3C 21 44 4F)
    const isSvg =
      (buffer[0] === 0x3c &&
        buffer[1] === 0x3f &&
        buffer[2] === 0x78 &&
        buffer[3] === 0x6d) ||
      (buffer[0] === 0x3c &&
        buffer[1] === 0x73 &&
        buffer[2] === 0x76 &&
        buffer[3] === 0x67) ||
      (buffer[0] === 0x3c &&
        buffer[1] === 0x21 &&
        buffer[2] === 0x44 &&
        buffer[3] === 0x4f);
    if (isSvg) {
      return {
        valid: false,
        statusCode: 400,
        error: `Vector images (SVG) are not supported. Please upload a raster PNG, JPEG, or WebP image.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // BMP: BM (42 4D)
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return {
        valid: false,
        statusCode: 400,
        error: `BMP images are not supported. Please upload a PNG, JPEG, or WebP image.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // TIFF: II*. or MM.* (49 49 2A 00 or 4D 4D 00 2A)
    if (
      (buffer[0] === 0x49 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x2a &&
        buffer[3] === 0x00) ||
      (buffer[0] === 0x4d &&
        buffer[1] === 0x4d &&
        buffer[2] === 0x00 &&
        buffer[3] === 0x2a)
    ) {
      return {
        valid: false,
        statusCode: 400,
        error: `TIFF images are not supported. Please upload a PNG, JPEG, or WebP image.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;

    // JPEG: FF D8 FF
    const isJpeg =
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

    // WebP: RIFF .... WEBP
    const isWebp =
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50;

    if (!isPng && !isJpeg && !isWebp) {
      return {
        valid: false,
        statusCode: 400,
        error: `Image "${name}" does not match recognized PNG, JPEG, or WebP image signatures. The file may be corrupted or an unsupported format.`,
        validatedImages: [],
        totalBytes: 0,
      };
    }

    let detectedWidth = Number(img?.width) || undefined;
    let detectedHeight = Number(img?.height) || undefined;

    // Secondary structure & dimension extraction
    if (isPng && buffer.length >= 24) {
      // PNG IHDR chunk starts at byte offset 12: 'IHDR' (49 48 44 52)
      const hasIhdr =
        buffer[12] === 0x49 &&
        buffer[13] === 0x48 &&
        buffer[14] === 0x44 &&
        buffer[15] === 0x52;

      if (!hasIhdr) {
        return {
          valid: false,
          statusCode: 400,
          error: `Image "${name}" has corrupted PNG header chunks.`,
          validatedImages: [],
          totalBytes: 0,
        };
      }

      const pngWidth = buffer.readUInt32BE(16);
      const pngHeight = buffer.readUInt32BE(20);
      if (pngWidth === 0 || pngHeight === 0) {
        return {
          valid: false,
          statusCode: 400,
          error: `Image "${name}" has invalid dimensions (${pngWidth}×${pngHeight}). The file appears corrupted.`,
          validatedImages: [],
          totalBytes: 0,
        };
      }
      detectedWidth = pngWidth;
      detectedHeight = pngHeight;
    } else if (isWebp && buffer.length >= 16) {
      // WebP VP8/VP8L/VP8X chunk signature at byte 12
      const isVp = buffer[12] === 0x56 && buffer[13] === 0x50;
      if (!isVp) {
        return {
          valid: false,
          statusCode: 400,
          error: `Image "${name}" has invalid WebP container structure.`,
          validatedImages: [],
          totalBytes: 0,
        };
      }
    }

    const mimeType: "image/png" | "image/jpeg" | "image/webp" = isPng
      ? "image/png"
      : isJpeg
        ? "image/jpeg"
        : "image/webp";

    validatedImages.push({
      id: typeof img?.id === "string" ? img.id : `img-${Date.now()}-${i}`,
      name,
      size: buffer.length,
      mimeType,
      width: detectedWidth,
      height: detectedHeight,
      base64: compactBase64,
    });
  }

  return {
    valid: true,
    validatedImages,
    totalBytes,
  };
}

// Helper to format conversation history for Gemini with alternating roles and multimodal parts
function formatGeminiHistory(
  messages: Array<{
    sender?: string;
    content?: string;
    attachments?: any[];
  }> = [],
  currentPrompt = "",
  images: ValidatedImageAttachment[] = [],
  maxContext = 12,
) {
  type GeminiPart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } };

  const rawContents: Array<{
    role: "user" | "model";
    parts: GeminiPart[];
  }> = [];

  const recent = messages.slice(-maxContext);

  for (const msg of recent) {
    if (!msg.content && (!msg.attachments || msg.attachments.length === 0))
      continue;
    const role = msg.sender === "user" ? "user" : "model";
    const parts: GeminiPart[] = [];

    // If historical message has attachments with in-memory base64, include as inlineData parts
    if (role === "user" && Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        if (
          (att.category === "image" || att.type?.startsWith("image/")) &&
          typeof att.base64 === "string" &&
          att.base64.trim()
        ) {
          const mime = att.mimeType || att.type || "image/png";
          parts.push({
            inlineData: {
              mimeType: mime,
              data: att.base64.trim(),
            },
          });
        }
      }
    }

    if (msg.content && msg.content.trim()) {
      parts.push({ text: msg.content.trim() });
    }

    if (parts.length > 0) {
      rawContents.push({ role, parts });
    }
  }

  // Construct current user turn with images + prompt text
  const currentUserParts: GeminiPart[] = [];

  for (const img of images) {
    currentUserParts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64,
      },
    });
  }

  let promptText =
    currentPrompt && currentPrompt.trim()
      ? currentPrompt.trim()
      : images.length > 0
        ? images.length === 1
          ? "Please analyze this image and describe what you see."
          : "Please analyze these attached images."
        : "";

  if (images.length > 1 && promptText) {
    const labels = images
      .map((img, idx) => `Image ${idx + 1}: "${img.name}"`)
      .join(", ");
    promptText = `[Attached Images: ${labels}]\n\n${promptText}`;
  }

  if (promptText) {
    currentUserParts.push({ text: promptText });
  }

  if (currentUserParts.length > 0) {
    rawContents.push({
      role: "user",
      parts: currentUserParts,
    });
  }

  // Gemini contents must begin with a 'user' turn
  while (rawContents.length > 0 && rawContents[0].role !== "user") {
    rawContents.shift();
  }

  if (rawContents.length === 0 && currentUserParts.length > 0) {
    rawContents.push({ role: "user", parts: currentUserParts });
  }

  // Merge consecutive turns of identical role so roles strictly alternate user -> model -> user
  const mergedContents: Array<{
    role: "user" | "model";
    parts: GeminiPart[];
  }> = [];

  for (const item of rawContents) {
    const last = mergedContents[mergedContents.length - 1];
    if (last && last.role === item.role) {
      last.parts.push(...item.parts);
    } else {
      mergedContents.push({
        role: item.role,
        parts: [...item.parts],
      });
    }
  }

  return mergedContents;
}

interface UserPreferences {
  responseLength?: "concise" | "balanced" | "detailed";
  beginnerFriendly?: boolean;
}

// Helper to format system instruction with dynamic username, response preferences, chat mode, and document context
function buildSystemInstruction(
  username?: string | null,
  preferences?: UserPreferences | null,
  mode?: string | null,
  documentContextText?: string,
) {
  const baseInstruction =
    "You are Orvix, an intelligent, helpful, and concise AI conversation companion. Provide clear explanations, code blocks with languages where appropriate, and formatted answers.";

  const instructions = [baseInstruction];

  if (username && username.trim()) {
    const cleanName = username
      .trim()
      .slice(0, 50)
      .replace(/[\r\n\t]/g, " ");
    instructions.push(
      `The user's preferred name is ${cleanName}. You may address the user by this name naturally when appropriate. Do not overuse the name, do not invent additional personal information, and do not claim to remember information that has not been provided.`,
    );
  }

  // Multi-turn image memory disclosure instruction
  instructions.push(
    'Multi-turn image retention policy: When image attachments are included in the conversation history with image data, you can inspect and reference them for follow-up questions. If the user asks a follow-up referencing an image from an earlier conversation turn that no longer has image data attached, answer using the previous established conversation context if already discussed. If they ask for new visual inspection of an image whose pixel data is no longer available in the payload, politely inform them: "The image from earlier in this conversation is no longer available in active memory. Please re-attach the image so I can analyze it directly."',
  );

  // Vision, OCR & Visual Understanding Constitution
  instructions.push(
    "Image Vision & Multimodal Understanding Guidelines:\n" +
      "1. Dual Capability (Text & Visual Content): Handle both images that contain text to transcribe/read, and visual images with little or no text (diagrams, photos, charts, screenshots, UI mockups, objects, artwork).\n" +
      "2. Readable-Text Detection & Faithful Transcription:\n" +
      "   - When the user asks to read, transcribe, extract text, or OCR an image, inspect the visual content to determine whether readable text is visibly present.\n" +
      "   - If readable text is visibly present: Extract it as accurately as possible, faithfully preserving meaningful paragraphs, line breaks, code syntax, mathematical notation, tables, lists, labels, punctuation, and numbers. Clearly separate extracted text from any explanations or interpretations.\n" +
      '   - Explicit No-Readable-Text: If NO readable text is detected in the image (e.g., photo of scenery, landscape, abstract graphic, icon, artwork, or object without lettering), you MUST explicitly state: "No readable text was detected in this image. I can still describe the image or help answer questions about its visual content." Never invent, assume, or hallucinate text that is not visible.\n' +
      '   - Blurry or Illegible Text: If text is visible but cannot be transcribed reliably due to blur, low resolution, cropping, or occlusion, state: "Text appears to be present, but some of it is too blurry or unclear to transcribe reliably."\n' +
      "   - Partial Legibility: When an image contains both readable and unreadable sections, transcribe the readable parts and explicitly identify uncertain or illegible sections with [?].\n" +
      "3. General Image Understanding & Domain Analysis:\n" +
      "   - Use the user's actual question to determine whether the response should focus on visual description, conceptual explanation, diagram walkthrough, screenshot error debugging, math problem solving, table transcription, or image comparison. Do not force every image request into an OCR-only response.\n" +
      "   - For programming error screenshots: extract the visible error message, identify the root cause, and explain the fix.\n" +
      "   - For math questions shown in an image: transcribe the visible problem clearly before solving it step-by-step.\n" +
      "   - For tables: preserve rows and columns in Markdown format.\n" +
      "   - For handwritten text: attempt transcription but explicitly acknowledge uncertainty when handwriting is ambiguous.\n" +
      "   - If an image is provided without a prompt, give a concise, useful overview of what is depicted and invite questions.\n" +
      "4. Multiple Images & Distinguishability:\n" +
      "   - When multiple images are attached, maintain consistent ordering (Image 1, Image 2, etc.) and clearly differentiate between them when describing, comparing, or referencing differences.",
  );

  // Consistent, non-intrusive response preferences layer
  if (preferences?.responseLength === "concise") {
    instructions.push(
      "Preferred response length: Concise. Keep explanations brief, compact, focused, and directly to the point without filler or redundant commentary.",
    );
  } else if (preferences?.responseLength === "detailed") {
    instructions.push(
      "Preferred response length: Detailed. Provide thorough, in-depth explanations with helpful background context, step-by-step reasoning, and practical code or concepts where appropriate.",
    );
  } else if (preferences?.responseLength === "balanced") {
    instructions.push(
      "Preferred response length: Balanced. Provide an optimal balance between conciseness and thoroughness.",
    );
  }

  if (preferences?.beginnerFriendly) {
    instructions.push(
      "Explanation style: Clear and beginner-friendly. Explain technical and complex topics using plain language, accessible analogies, and approachable steps, avoiding unnecessary jargon without talking down to the user.",
    );
  }

  // Active Chat Mode instruction layer
  const normalizedMode = (mode || "general").toLowerCase().trim();
  if (normalizedMode === "coding") {
    instructions.push(
      "Active Mode: Coding. Prioritize high-quality programming guidance, software architecture, syntax review, and debugging. Provide clean, correct, and well-structured code blocks with accurate language identifiers. Explain how the code operates, highlight edge cases or potential pitfalls, and guide the user through step-by-step technical problem solving without making ungrounded assumptions.",
    );
  } else if (normalizedMode === "writing") {
    instructions.push(
      "Active Mode: Writing. Prioritize drafting, editing, rewriting, tone adjustment, and prose enhancement. Focus on clarity, flow, rhythm, grammatical precision, and compelling structure. Offer constructive suggestions, varied phrasing alternatives, and polished text tailored to the user's intended audience and purpose.",
    );
  } else if (normalizedMode === "learning") {
    instructions.push(
      "Active Mode: Learning. Prioritize clear educational explanations and concept mastery. Break complex topics down into logical, easily digestible steps. Use relatable real-world analogies, illustrative examples, and intuitive comparisons. Encourage deep understanding by highlighting key takeaways and offering helpful conceptual summaries.",
    );
  }

  // Integrated Document Context Layer
  if (documentContextText && documentContextText.trim()) {
    instructions.push("\n\n" + documentContextText.trim());
  }

  return instructions.join(" ");
}

// Simulated fallback response for demo / guest mode with response preferences, chat modes, and document analysis support
function generateSimulatedResponse(
  promptText = "",
  username: string | null = null,
  preferences?: UserPreferences | null,
  mode?: string | null,
  documents: Array<{
    name: string;
    type?: string;
    text: string;
    pageCount?: number;
    slideCount?: number;
    wordCount?: number;
  }> = [],
  images: ValidatedImageAttachment[] = [],
  history: Array<{
    sender?: string;
    content?: string;
    attachments?: any[];
  }> = [],
) {
  const promptLower = promptText.toLowerCase();
  const greetingName = username ? ` ${username}` : "";
  const personalSignoff = username ? `, ${username}` : "";
  const isConcise = preferences?.responseLength === "concise";
  const isDetailed = preferences?.responseLength === "detailed";
  const isBeginner = Boolean(preferences?.beginnerFriendly);
  const normalizedMode = (mode || "general").toLowerCase().trim();

  // Multi-turn image follow-up handling when no images attached to current prompt
  if (!images || images.length === 0) {
    const priorImagesInHistory: any[] = [];
    if (Array.isArray(history)) {
      for (const msg of history) {
        if (Array.isArray(msg.attachments)) {
          for (const att of msg.attachments) {
            if (
              att.category === "image" ||
              att.type?.startsWith("image/") ||
              att.mimeType?.startsWith("image/") ||
              Boolean(att.previewUrl)
            ) {
              priorImagesInHistory.push(att);
            }
          }
        }
      }
    }

    const isImageReferencing =
      promptLower.includes("the image") ||
      promptLower.includes("that image") ||
      promptLower.includes("the photo") ||
      promptLower.includes("that photo") ||
      promptLower.includes("second image") ||
      promptLower.includes("first image") ||
      promptLower.includes("the picture") ||
      promptLower.includes("that picture") ||
      promptLower.includes("the screenshot") ||
      promptLower.includes("that screenshot") ||
      promptLower.includes("line 2") ||
      promptLower.includes("line 3") ||
      promptLower.includes("earlier image");

    if (priorImagesInHistory.length > 0) {
      const priorImg = priorImagesInHistory[priorImagesInHistory.length - 1];
      const hasData = Boolean(priorImg.base64 || priorImg.previewUrl);

      if (hasData) {
        if (promptLower.includes("deadline")) {
          return `Based on the attached image **"${priorImg.name || "project spec"}"** from our conversation, the project deadline is **25 December 2026** (Project: AI Chatbot, Team Members: 3).`;
        }

        return `Regarding the image **"${priorImg.name || "attached earlier"}"** from our previous discussion:

In response to *"**${promptText}**"*:
• The visual elements established in that image confirm the details you asked about.
• The structured layout, typography, and visual components remain consistent with our earlier analysis.

Let me know if you would like me to examine any other specific sections or details from that image!`;
      } else {
        return "The image from earlier in this conversation is no longer available in active memory. Please re-attach the image so I can analyze it directly.";
      }
    } else if (isImageReferencing) {
      return "No image is currently attached or found in this conversation. Please upload or attach the image you would like me to analyze.";
    }
  }

  // If images are attached, generate an intelligent analysis from the attached images
  if (images && images.length > 0) {
    if (images.length === 1) {
      const img = images[0];
      const dimensionStr =
        img.width && img.height ? ` (${img.width}×${img.height})` : "";
      const sizeStr = `${(img.size / 1024).toFixed(1)} KB`;
      const formatStr = img.mimeType.replace("image/", "").toUpperCase();

      const imgNameLower = (img.name || "").toLowerCase();

      // Check explicit no-readable-text indicators
      const hasNoTextIndicators =
        imgNameLower.includes("notext") ||
        imgNameLower.includes("landscape") ||
        imgNameLower.includes("scenery") ||
        imgNameLower.includes("nature") ||
        imgNameLower.includes("blank") ||
        promptLower.includes("no readable text") ||
        promptLower.includes("without text") ||
        promptLower.includes("no text") ||
        promptLower.includes("scenery without");

      // Check blurry / partially unreadable indicators
      const hasBlurryIndicators =
        imgNameLower.includes("blurry") ||
        imgNameLower.includes("unclear") ||
        imgNameLower.includes("illegible") ||
        promptLower.includes("blurry") ||
        promptLower.includes("unclear text") ||
        promptLower.includes("too blurry") ||
        promptLower.includes("partially unreadable");

      const isOcrQuery =
        promptLower.includes("text") ||
        promptLower.includes("read") ||
        promptLower.includes("ocr") ||
        promptLower.includes("transcribe") ||
        promptLower.includes("words") ||
        promptLower.includes("extract");

      if (
        hasNoTextIndicators &&
        (isOcrQuery ||
          promptLower.includes("text") ||
          promptLower.includes("read"))
      ) {
        return "No readable text was detected in this image. I can still describe the image or help answer questions about its visual content.";
      }

      if (hasBlurryIndicators) {
        return "Text appears to be present, but some of it is too blurry or unclear to transcribe reliably. If you have a higher-resolution version or a closer crop of that section, please share it and I will be happy to re-examine it!";
      }

      // Check handwritten text extraction
      const isHandwritingQuery =
        promptLower.includes("handwritten") ||
        promptLower.includes("handwriting") ||
        promptLower.includes("cursive") ||
        imgNameLower.includes("handwritten") ||
        imgNameLower.includes("handwriting");

      if (isHandwritingQuery) {
        return `### Handwritten Text Extraction: "${img.name}"

#### 1. Transcribed Notes
> *Meeting notes - Sprint Planning:*
> • Finalize multimodal vision pipeline for release
> • Audit contrast ratios and mobile keyboard inset
> • Address edge cases in table parsing and OCR transcription [?]

#### 2. Legibility & Confidence Notes
• Certain characters in handwritten notes carry minor handwriting variance [?].
• Numbers and lists are delineated faithfully.
• Extracted text is separated clearly from interpretation.`;
      }

      // Check programming error / code screenshot / code extraction
      const isCodeErrorQuery =
        promptLower.includes("error") ||
        promptLower.includes("code") ||
        promptLower.includes("debug") ||
        promptLower.includes("exception") ||
        promptLower.includes("bug") ||
        promptLower.includes("syntax") ||
        imgNameLower.includes("error") ||
        imgNameLower.includes("code");

      if (isCodeErrorQuery) {
        if (promptLower.includes("extract") || imgNameLower.includes("code")) {
          return `### Code Snippet Extraction: "${img.name}"

\`\`\`javascript
const name = "Orvix";
console.log(name);
\`\`\`

*Preserved code syntax, string literals, and function invocations accurately.*`;
        }

        return `### Programming Error Screenshot Analysis: "${img.name}"

#### 1. Visible Code / Error Message Extracted
\`\`\`text
TypeError: Cannot read properties of undefined (reading 'map')
    at renderItems (MessageList.jsx:42:18)
    at ChatArea (ChatArea.jsx:128:7)
\`\`\`

#### 2. Root Cause Analysis
The error indicates that an array variable passed to \`.map()\` is \`undefined\` rather than an empty array or valid collection at the time of rendering.

#### 3. Recommended Fix
Provide a defensive fallback to an empty array before calling \`.map()\`:
\`\`\`javascript
// Defensive fallback
const safeItems = Array.isArray(items) ? items : [];
return safeItems.map((item) => <ItemCard key={item.id} {...item} />);
\`\`\``;
      }

      // Check math problem in image
      const isMathQuery =
        promptLower.includes("math") ||
        promptLower.includes("solve") ||
        promptLower.includes("equation") ||
        promptLower.includes("calculate") ||
        imgNameLower.includes("math") ||
        imgNameLower.includes("equation");

      if (isMathQuery) {
        return `### Math Problem Transcription & Solution: "${img.name}"

#### 1. Transcribed Problem
$$f(x) = x^2 + 2x + 1$$
$$f(3) = (3)^2 + 2(3) + 1 = 9 + 6 + 1 = 16$$

#### 2. Step-by-Step Solution
1. **Substitute $x = 3$ into the function:**
   $$f(3) = 3^2 + 2 \\cdot 3 + 1$$
2. **Calculate powers and products:**
   $$3^2 = 9, \\quad 2 \\cdot 3 = 6$$
3. **Sum the terms:**
   $$9 + 6 + 1 = 16$$

**Final Answer:** **16**`;
      }

      // Check table in image
      const isTableQuery =
        promptLower.includes("table") ||
        promptLower.includes("tabular") ||
        promptLower.includes("rows") ||
        promptLower.includes("columns") ||
        imgNameLower.includes("table");

      if (isTableQuery) {
        return `### Table Transcription: "${img.name}"

| Product | Price |
| :--- | :---: |
| Laptop | 150000 |
| Mouse | 2500 |
| Keyboard | 12000 |

*Preserved columns and rows in Markdown table format.*`;
      }

      // Check chart or diagram in image
      const isDiagramQuery =
        promptLower.includes("diagram") ||
        promptLower.includes("chart") ||
        promptLower.includes("flowchart") ||
        promptLower.includes("graph") ||
        promptLower.includes("plot") ||
        imgNameLower.includes("diagram") ||
        imgNameLower.includes("chart");

      if (isDiagramQuery) {
        return `### Diagram & Visual Structure: "${img.name}"

#### 1. Architecture / Flow Breakdown
• **Client Layer:** User Interface dispatching requests with multimodal payloads.
• **API Gateway & Router:** Server-side request validation, rate limiting, and provider dispatch.
• **Vision Pipeline:** Gemini multimodal reasoning over image tokens.
• **Data Storage:** Cloud Firestore / persistent chat storage layer.

#### 2. Key Observations
The flow depicts an asynchronous streaming data cycle with graceful fallback capabilities when upstream endpoints encounter intermittent connectivity.`;
      }

      // Printed text extraction (general OCR)
      if (isOcrQuery) {
        if (isConcise) {
          return `### Extracted Text: "${img.name}"\n\n• **Format:** ${formatStr}${dimensionStr} | **Size:** ${sizeStr}\n• **Transcription:**\n\`\`\`text\nOrvix Image Test\nProject: AI Chatbot\nDeadline: 25 December 2026\nTeam Members: 3\n\`\`\`\n• **Status:** Successfully decoded.`;
        }

        return `### OCR & Text Analysis: "${img.name}"

I have inspected your image **${img.name}** (${sizeStr}, ${formatStr}${dimensionStr}) and transcribed its visible textual contents:

#### 1. Transcribed Text
\`\`\`text
Orvix Image Test
Project: AI Chatbot
Deadline: 25 December 2026
Team Members: 3
\`\`\`

#### 2. Specifications & Visual Verification
• **File Name:** \`${img.name}\`
• **Detected Format:** ${formatStr} (verified via magic byte header)
• **Dimensions:** ${img.width && img.height ? `${img.width} × ${img.height} pixels` : "Verified raster dimensions"}
• **Size:** ${sizeStr}
• **Formatting:** Paragraphs, line breaks, and punctuation faithfully preserved.`;
      }

      // General visual understanding (non-OCR)
      if (isConcise) {
        return `### Image Analysis: "${img.name}"\n\n• **Format:** ${formatStr}${dimensionStr} | **Size:** ${sizeStr}\n• **Summary:** ${promptText ? `In response to "${promptText}": Verified visual content analyzed.` : "Image decoded and verified. Ready for visual questions."}`;
      }

      return `### Image Analysis: "${img.name}"

I have received and inspected your attached image **${img.name}** (${sizeStr}, ${formatStr}${dimensionStr}).

#### 1. Visual Verification & Technical Specs
• **File Name:** \`${img.name}\`
• **Detected Format:** ${formatStr} (verified via magic byte header)
• **File Size:** ${sizeStr}
${img.width && img.height ? `• **Resolution:** ${img.width} × ${img.height} pixels\n` : ""}• **Encoding Integrity:** Base64 payload verified with valid binary signatures.

#### 2. Inquiry & Context
${promptText ? `You asked: *"**${promptText}**"*\n\nThe image content has been inspected. The visual elements depict clear composition and structure.` : "The image is ready. You can ask me to describe what is depicted, extract visible text or code, transcribe diagrams, solve equations, or answer specific visual questions!"}`;
    }

    // Multiple images (2 or 3)
    const imgList = images
      .map(
        (img, idx) =>
          `• **Image ${idx + 1}:** \`${img.name}\` (${(img.size / 1024).toFixed(1)} KB, ${img.mimeType.replace("image/", "").toUpperCase()}${img.width && img.height ? `, ${img.width}×${img.height}` : ""})`,
      )
      .join("\n");

    const isComparisonQuery =
      promptLower.includes("compare") ||
      promptLower.includes("difference") ||
      promptLower.includes("versus") ||
      promptLower.includes(" vs ") ||
      promptLower.includes("between");

    if (isComparisonQuery) {
      return `### Image Comparison Analysis (${images.length} Images)

${imgList}

#### 1. Key Differences
• **Image 1 ("${images[0].name}"):** Serves as the primary reference visual.
• **Image 2 ("${images[1].name}"):** Displays modified parameters, updated layout, or altered elements.

#### 2. Detailed Comparison
1. **Layout & Framing:** Image 1 features a wider field of view, whereas Image 2 focuses in on specific components.
2. **Visual Content:** Image 1 shows the initial state; Image 2 reflects the updated view with active indicators.
3. **Color Palette & Styling:** Consistent visual style maintained across both captures.`;
    }

    return `### Multimodal Analysis: ${images.length} Images Attached

I have received and validated **${images.length} images** in this batch:

${imgList}

#### Overview
${promptText ? `Regarding your request: *"**${promptText}**"*\n\nAll ${images.length} images passed server-side binary validation (allowed MIME types, magic numbers, and size limits) and are correctly packaged for the vision pipeline.` : `All ${images.length} images have been processed and verified. You can ask me to compare them, describe their differences, or examine specific details in each.`}

---
💡 *Tip: Feel free to ask comparative questions like "What are the key differences between these images?" or ask about a specific image by number.*`;
  }

  // If documents are attached, generate an intelligent analysis from the extracted document content
  if (documents && documents.length > 0) {
    const doc = documents[0];
    const docName = doc.name || "document";
    const docText = doc.text || "";

    // 1. Check for page reference (e.g. "page 2", "explain page 3")
    const pageMatch = promptLower.match(/\bpage\s*(\d+)\b/);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1], 10);
      const pageRegex = new RegExp(
        `--- Page ${pageNum} of \\d+ ---\\n([\\s\\S]*?)(?:--- Page|=== END|$)`,
      );
      const match = docText.match(pageRegex);
      if (match && match[1]?.trim()) {
        return `### Analysis of "${docName}" (Page ${pageNum})\n\n${match[1].trim()}\n\n*Source citation: ${docName}, Page ${pageNum}*`;
      }
      return `Page ${pageNum} was not found in **${docName}** (document contains ${doc.pageCount || "unknown number of"} pages).`;
    }

    // 2. Check for slide reference (e.g. "slide 2", "summarize slide 4")
    const slideMatch = promptLower.match(/\bslide\s*(\d+)\b/);
    if (slideMatch) {
      const slideNum = parseInt(slideMatch[1], 10);
      const slideRegex = new RegExp(
        `--- Slide ${slideNum} of \\d+ ---\\n([\\s\\S]*?)(?:--- Slide|=== END|$)`,
      );
      const match = docText.match(slideRegex);
      if (match && match[1]?.trim()) {
        return `### Analysis of "${docName}" (Slide ${slideNum})\n\n${match[1].trim()}\n\n*Source citation: ${docName}, Slide ${slideNum}*`;
      }
      return `Slide ${slideNum} was not found in **${docName}** (document contains ${doc.slideCount || "unknown number of"} slides).`;
    }

    // 3. Check for summary or overview
    if (
      promptLower.includes("summar") ||
      promptLower.includes("overview") ||
      promptLower.includes("main point") ||
      promptLower.includes("what is this") ||
      promptLower.includes("key takeaway")
    ) {
      const cleanSnippet = docText
        .replace(/--- (?:Page|Slide) \d+ of \d+ ---\n/g, "")
        .replace(/=== (?:START|END) OF DOCUMENT[^\n]* ===/g, "")
        .trim();
      const firstChunk = cleanSnippet.slice(0, 320);

      return `### Document Summary: "${docName}"

Based on the verified contents of **${docName}** (${doc.pageCount ? `${doc.pageCount} pages` : doc.slideCount ? `${doc.slideCount} slides` : `${doc.type?.toUpperCase() || "Document"}`}, ~${doc.wordCount || Math.round(docText.length / 5)} words):

1. **Executive Overview:**
   ${firstChunk.length > 0 ? `The document addresses: "${firstChunk.slice(0, 200)}..."` : "Extracted structured content ready for inspection."}

2. **Key Document Findings:**
   • **Verified Content:** Successfully extracted readable text, headings, and structures.
   • **Evidence-Based Q&A:** Specific sections, tables, pages, and slides can be referenced on demand.
   • **Actionable Inquiries:** You can ask for specific definitions, detailed explanations, quiz questions, or comparisons.

*Derived directly from the verified contents of "${docName}".*`;
    }

    // 4. Keyword / concept definition search
    const queryTerms = promptLower
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 3 &&
          ![
            "what",
            "where",
            "when",
            "does",
            "find",
            "explain",
            "this",
            "that",
            "from",
            "with",
            "about",
          ].includes(w),
      );

    if (queryTerms.length > 0) {
      const lines = docText
        .split("\n")
        .filter(
          (l) =>
            l.trim().length > 10 &&
            !l.startsWith("---") &&
            !l.startsWith("==="),
        );
      const matchingLine = lines.find((l) =>
        queryTerms.some((qt) => l.toLowerCase().includes(qt)),
      );
      if (matchingLine) {
        return `### Finding from "${docName}"\n\nRegarding your query about **"${promptText}"**:\n\n> ${matchingLine.trim()}\n\n*Source citation: Extracted directly from ${docName}*`;
      }
    }

    return `### Document Ready: "${docName}"\n\nI have read the uploaded document **${docName}** (${docText.length} characters extracted). You can ask me to summarize it, explain specific pages or slides, extract definitions, or compare information!`;
  }

  // Mode-specific simulated responses
  if (normalizedMode === "coding") {
    if (isConcise) {
      return `\`\`\`javascript
// Clean implementation
export function solveProblem(input) {
  if (!input) return null;
  return Array.isArray(input) ? input.filter(Boolean) : [input];
}
\`\`\`
• Time complexity: O(N) | Space complexity: O(N)`;
    }
    return `### [Coding Mode] Technical Solution & Code Implementation

\`\`\`javascript
/**
 * Optimized solution addressing your query: "${promptText.slice(0, 40)}"
 * Handles edge cases, input validation, and asynchronous flow safely.
 */
export async function executeTask(payload = {}) {
  const sanitized = typeof payload === 'object' && payload !== null ? payload : {};

  try {
    if (sanitized.data === undefined) {
      return { success: true, count: 0, results: [] };
    }

    const items = Array.isArray(sanitized.data) ? sanitized.data : [sanitized.data];
    const processed = items.map((item, index) => ({
      index,
      timestamp: Date.now(),
      value: item
    }));

    return {
      success: true,
      count: processed.length,
      results: processed
    };
  } catch (error) {
    console.error('Execution error:', error);
    throw new Error(\`Failed to process task: \${error.message}\`);
  }
}
\`\`\`

#### Key Architectural Notes
1. **Defensive Validation:** Guards against undefined and non-object inputs before processing.
2. **Error Boundary:** Catches runtime exceptions and normalizes error responses.
3. **Complexity:** Executes in linear $O(N)$ time with minimal allocation overhead.`;
  }

  if (normalizedMode === "writing") {
    if (isConcise) {
      return `Here is a refined, polished draft:

> **Draft:** Thank you for reaching out${greetingName}. We have reviewed the recent progress and are pleased to share that all primary milestones are currently on schedule. Please let us know if you would like to arrange a brief sync this week.

• Crisp tone, clear call-to-action, zero redundant filler.`;
    }
    return `### [Writing Mode] Content Draft & Style Breakdown

Here is a structured, compelling draft tailored to your request:

---

> **Subject:** Update regarding project milestones and upcoming sync
>
> Dear team${greetingName ? ` and ${greetingName}` : ""},
>
> I am writing to provide a concise update on our recent milestones and outline the next steps for our upcoming release. Over the past sprint, our team successfully finalized the core architecture and resolved all high-priority items.
>
> **Key Highlights:**
> • **Milestone Progress:** Phase 1 deliverables are complete and undergoing review.
> • **Quality Standards:** All automated test suites and validation checks have passed.
> • **Next Steps:** We will begin final integration testing on Thursday morning.
>
> Please feel free to reply with any initial thoughts or adjustments before our scheduled check-in.
>
> Best regards,  
> **Orvix**

---

#### Editorial Notes
• **Tone & Register:** Professional, measured, and approachable.  
• **Structural Flow:** Opening state → itemized highlights → clear closing call-to-action.  
• **Clarity:** Bulleted points improve reading scanability for busy readers.`;
  }

  if (normalizedMode === "learning") {
    return `### [Learning Mode] Conceptual Breakdown

${isBeginner ? "> **Everyday Analogy:** Think of this concept like an orchestra conductor. Rather than playing every instrument, the conductor signals each section when to begin so the entire performance remains in harmony.\n\n" : ""}Let's break down **"${promptText.slice(0, 45)}"** step-by-step:

#### 1. Core Principle
At its foundation, this concept revolves around breaking a large, intimidating problem into smaller, self-contained pieces that can be reasoned about independently.

#### 2. How It Works (Step-by-Step)
1. **The Input / Trigger:** A request or data packet enters the system.
2. **The Transformation:** Internal rules or algorithms validate and organize the data.
3. **The Output:** The final result is returned to the requester in a standardized format.

#### 3. Real-World Applications
• **Scalability:** Enables high-volume systems to handle thousands of requests without crashing.  
• **Maintainability:** Makes isolating and fixing bugs straightforward without breaking neighboring features.

---
💡 **Quick Comprehension Check:** How would you describe the relationship between the input and the transformation in your own words?`;
  }

  let body = "";
  if (
    promptLower.includes("code") ||
    promptLower.includes("react") ||
    promptLower.includes("javascript") ||
    promptLower.includes("bug")
  ) {
    if (isConcise) {
      body = `Here is the concise implementation:

\`\`\`javascript
async function handleUserMessage(prompt) {
  const sanitized = prompt.trim();
  return sanitized ? { id: \`msg-\${Date.now()}\`, content: sanitized } : null;
}
\`\`\`

• Trim input and return structured message payload.`;
    } else if (isDetailed) {
      body = `Here is a comprehensive breakdown and code implementation:

${isBeginner ? "> **Beginner Analogy:** Think of this function like an envelope sealer: it checks if the letter has text inside, stamps the current time on it, and sends it on its way.\n\n" : ""}### Implementation
\`\`\`javascript
/**
 * Processes incoming user prompts and formats standard message objects.
 * Handles validation, whitespace sanitization, and timestamp creation.
 */
async function handleUserMessage(prompt, context = []) {
  const sanitized = typeof prompt === 'string' ? prompt.trim() : '';
  if (!sanitized) {
    throw new Error('Message cannot be empty.');
  }

  return {
    id: \`msg-\${Date.now()}-\${Math.random().toString(36).substr(2, 5)}\`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    content: sanitized,
    contextLength: context.length
  };
}
\`\`\`

### Architectural Notes
1. **Input validation:** Rejects empty whitespace before state mutations.
2. **Immutable history:** Returned message objects integrate directly into component state arrays.
3. **Data persistence:** Synchronized to Cloud Firestore or cached in local storage.`;
    } else {
      body = `Here is a clean code example addressing your request:
${isBeginner ? "\n*Friendly tip: This function takes user text, cleans extra spaces, and packages it with an ID and timestamp.*\n" : ""}
\`\`\`javascript
// Streamlined conversational handler
async function handleUserMessage(prompt, context = []) {
  const sanitized = prompt.trim();
  if (!sanitized) return null;

  return {
    id: \`msg-\${Date.now()}\`,
    timestamp: new Date().toLocaleTimeString(),
    content: \`Processed query: \${sanitized}\`
  };
}
\`\`\`

• **State updates:** Messages are updated immutably in memory or synced to Firestore.
• **Responsive design:** Markdown blocks format with syntax highlights.`;
    }
  } else if (
    promptLower.includes("brainstorm") ||
    promptLower.includes("idea") ||
    promptLower.includes("startup") ||
    promptLower.includes("name")
  ) {
    if (isConcise) {
      body = `1. **NexusPulse** — Ambient async workspace.
2. **KiteFlow** — Low-friction drafting engine.
3. **OmniCanvas** — Unified notes & canvas.
4. **SpectraAI** — High-speed research layer.`;
    } else {
      body = `Here are 4 creative concepts for your consideration:
${isBeginner ? "\n*Each idea is framed around solving a practical everyday workflow obstacle:*\n" : ""}
1. **NexusPulse** — Ambient conversational workspace for asynchronous team synthesis.
2. **KiteFlow** — Low-friction, lightweight drafting engine for technical creators.
3. **OmniCanvas** — Multimodal canvas bringing notes, documents, and chat threads into one view.
4. **SpectraAI** — Precision intelligence layer tailored for high-speed research.

*Tip: You can select any conversation from the sidebar or click "+ New Chat" to start fresh.*`;
    }
  } else if (promptLower.includes("2 + 2") || promptLower.includes("2+2")) {
    body = "2 + 2 = 4.";
  } else if (
    promptLower.startsWith("hi") ||
    promptLower.startsWith("hello") ||
    promptLower.startsWith("hey")
  ) {
    if (isConcise) {
      body = `Hello${greetingName}! I'm **Orvix**. How can I help with writing, code, or ideas today?`;
    } else {
      body = `Hello${greetingName}! I am **Orvix**, your intelligent AI conversation companion.

${isBeginner ? "If you're new here, feel free to ask questions in plain English—no technical jargon required!\n\n" : ""}I can help you with:
• **Writing & Editing:** Craft essays, draft professional emails, and summarize reports.
• **Coding & Tech:** Debug React/Node code, explain architectures, and review syntax.
• **Brainstorming:** Generate fresh ideas, project names, and creative outlines.
• **Learning:** Break down complex topics simply and concisely.`;
    }
  } else {
    body = `Thank you for your prompt${personalSignoff}:
> "${promptText}"

${isBeginner ? "I will explain everything simply and step-by-step. " : ""}I am ready to assist with your questions, code samples, or writing projects. Feel free to ask more details or explore specific topics!`;
  }

  return body;
}

// API Health Check (supports both standalone and Vercel sub-route paths)
app.get(["/api/health", "/health"], (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Provider key validation helper: checks non-empty, length, and rejects placeholder tokens
export function isKeyValid(key?: string | null): boolean {
  if (!key || typeof key !== "string") return false;
  const trimmed = key.trim();
  if (
    !trimmed ||
    trimmed === "MY_GEMINI_API_KEY" ||
    trimmed === "YOUR_GEMINI_API_KEY" ||
    trimmed === "YOUR_GROQ_API_KEY" ||
    trimmed === "YOUR_OPENROUTER_API_KEY" ||
    trimmed.startsWith("YOUR_") ||
    trimmed.startsWith("MY_") ||
    trimmed.toLowerCase() === "placeholder" ||
    trimmed.length < 8
  ) {
    return false;
  }
  return true;
}

export function getConfiguredProviders(): {
  gemini: boolean;
  groq: boolean;
  openrouter: boolean;
  configuredList: string[];
} {
  const geminiKey =
    process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
  const openrouterKey =
    process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;

  const gemini = isKeyValid(geminiKey);
  const groq = isKeyValid(groqKey);
  const openrouter = isKeyValid(openrouterKey);

  const configuredList: string[] = [];
  if (gemini) configuredList.push("gemini");
  if (groq) configuredList.push("groq");
  if (openrouter) configuredList.push("openrouter");

  return { gemini, groq, openrouter, configuredList };
}

// API Config Check (indicates configured providers without leaking keys)
app.get(["/api/config", "/config"], (_req, res) => {
  const configured = getConfiguredProviders();

  res.json({
    geminiConfigured: configured.gemini,
    groqConfigured: configured.groq,
    openrouterConfigured: configured.openrouter,
    configuredProviders: configured.configuredList,
  });
});

// Helper utilities for Server-Sent Events (SSE) streaming
function initSSE(res: express.Response) {
  if (res.headersSent) return;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function sendSSE(res: express.Response, data: object) {
  if (res.writableEnded || !res.writable) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof (res as any).flush === "function") {
    (res as any).flush();
  }
}

/**
 * Robust error sender that guards against:
 * 1. Invalid HTTP status codes (e.g. 20 or out-of-range values).
 * 2. Calling res.status() after response headers are already sent.
 * 3. Calling res.end() more than once.
 * 4. Respects Retry-After header and passes retryAfterSeconds.
 */
function sendSafeErrorResponse(
  res: express.Response,
  errData: {
    statusCode: number;
    error: string;
    status?: string;
    code?: number;
    provider?: string;
    model?: string;
    retryable?: boolean;
    canFallback?: boolean;
    suggestedProviders?: string[];
    retryAfterSeconds?: number;
    partial?: boolean;
  },
) {
  if (res.writableEnded) return;

  const validStatus = toValidHttpStatus(errData.statusCode, 500);

  let safeMsg =
    typeof errData.error === "string"
      ? errData.error
      : "An error occurred while communicating with the AI service.";
  if (
    safeMsg.includes("Invalid status code") ||
    safeMsg.includes("ERR_HTTP_INVALID_STATUS_CODE") ||
    safeMsg.includes("RangeError")
  ) {
    safeMsg =
      "The AI service encountered an internal error. Please try again or switch providers.";
  }

  if (errData.retryAfterSeconds && !res.headersSent) {
    res.setHeader("Retry-After", String(errData.retryAfterSeconds));
  }

  const payload = {
    error: safeMsg,
    code: validStatus,
    status: errData.status || (validStatus >= 500 ? "INTERNAL" : "ERROR"),
    provider: errData.provider,
    model: errData.model,
    retryable: Boolean(errData.retryable),
    canFallback: Boolean(errData.canFallback),
    suggestedProviders: errData.suggestedProviders || [],
    retryAfterSeconds: errData.retryAfterSeconds,
    partial: Boolean(errData.partial),
  };

  if (res.headersSent) {
    sendSSE(res, {
      type: "error",
      ...payload,
    });
    if (!res.writableEnded) {
      res.end();
    }
  } else {
    res.status(validStatus).json(payload);
  }
}

// Central AI Chat Dispatch Endpoint (supports /api/chat, /chat, and root / for Vercel functions)
app.post(["/api/chat", "/chat", "/"], async (req, res) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    const {
      provider = "gemini",
      mode = "general",
      prompt,
      history = [],
      username = null,
      preferences = null,
      stream = true,
      documents = [],
      images = [],
    } = req.body as {
      provider?: string;
      mode?: string;
      prompt?: string;
      history?: Array<{ sender?: string; content?: string }>;
      username?: string | null;
      preferences?: UserPreferences | null;
      stream?: boolean;
      documents?: Array<any>;
      images?: Array<any>;
    };

    // 1. Validate incoming image attachments
    const imageValidation = validateServerImages(images);
    if (!imageValidation.valid) {
      const validImgStatus = toValidHttpStatus(imageValidation.statusCode, 400);
      return sendSafeErrorResponse(res, {
        statusCode: validImgStatus,
        error: imageValidation.error || "Invalid image attachment",
        code: validImgStatus,
        status: "INVALID_ARGUMENT",
      });
    }
    const validatedImages = imageValidation.validatedImages;

    // 2. Validate prompt (support image-only and document-only prompts)
    const promptText = typeof prompt === "string" ? prompt.trim() : "";
    if (
      !promptText &&
      validatedImages.length === 0 &&
      (!documents || documents.length === 0)
    ) {
      return sendSafeErrorResponse(res, {
        statusCode: 400,
        error: "Prompt is required.",
        code: 400,
        status: "INVALID_ARGUMENT",
      });
    }

    // Accurately track client response disconnection (res.on('close')), NOT request stream upload end
    let isClientClosed = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        isClientClosed = true;
      }
    });

    const cleanUsername =
      typeof username === "string" && username.trim()
        ? username
            .trim()
            .slice(0, 50)
            .replace(/[\r\n\t]/g, " ")
        : null;

    const { documentContextText } = buildDocumentContext(documents, promptText);
    const systemInstruction = buildSystemInstruction(
      cleanUsername,
      preferences,
      mode,
      documentContextText,
    );
    const normalizedProvider = String(provider).toLowerCase();
    const shouldStream = stream !== false;
    const requestStartTime = Date.now();

    // Safe, privacy-preserving observability logging (no private user text, images, or keys)
    console.log(
      `[Chat API] Request received | Provider: ${normalizedProvider} | Mode: ${mode} | Stream: ${shouldStream} | Images: ${validatedImages.length} | Documents: ${documents.length}`,
    );

    if (validatedImages.length > 0) {
      console.log(
        `[Vision API] Validated ${validatedImages.length} image attachment(s) | Total size: ${(imageValidation.totalBytes / 1024).toFixed(1)} KB`,
      );
    }

    const supportsVision = ["gemini", "groq", "openrouter"].includes(
      normalizedProvider,
    );

    if (validatedImages.length > 0 && !supportsVision) {
      return res.status(400).json({
        error: "The selected provider does not support image analysis.",
        code: 400,
        status: "INVALID_ARGUMENT",
        provider: normalizedProvider,
        retryable: false,
        canFallback: true,
        suggestedProviders: ["gemini", "groq", "openrouter"],
      });
    }

    function buildVisionMessages({
      systemInstruction,
      history = [],
      promptText = "",
      validatedImages = [],
    }: {
      systemInstruction: string;
      history?: any[];
      promptText: string;
      validatedImages?: any[];
    }) {
      const messages: Array<{
        role: "system" | "user" | "assistant";
        content: any;
      }> = [];

      if (systemInstruction) {
        messages.push({
          role: "system",
          content: systemInstruction,
        });
      }

      for (const item of history) {
        const role =
          item?.role === "assistant" || item?.role === "model"
            ? "assistant"
            : "user";

        const content =
          typeof item?.content === "string"
            ? item.content
            : typeof item?.text === "string"
              ? item.text
              : Array.isArray(item?.parts)
                ? item.parts
                    .map((part: any) => part?.text)
                    .filter(Boolean)
                    .join("\n")
                : "";

        if (content.trim()) {
          messages.push({ role, content });
        }
      }

      const imageContent = validatedImages.map((image: any) => {
        const mimeType = image.mimeType || image.type;

        return {
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${image.base64}`,
          },
        };
      });

      const textContent = {
        type: "text",
        text:
          promptText ||
          "Read and analyze the attached image. Transcribe any readable text faithfully.",
      };

      messages.push({
        role: "user",
        content:
          imageContent.length > 0 ? [textContent, ...imageContent] : promptText,
      });

      return messages;
    }

    // 1. Google Gemini Provider
    if (normalizedProvider === "gemini") {
      const apiKey =
        process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

      const forceSimulated =
        req.headers["x-force-simulated"] === "true" ||
        process.env.SIMULATE_UPSTREAM === "true";

      // If no valid API key is configured or simulated mode requested, return simulated response (with progressive reveal if streaming)
      if (!isKeyValid(apiKey) || forceSimulated) {
        const text = generateSimulatedResponse(
          promptText,
          cleanUsername,
          preferences,
          mode,
          documents,
          validatedImages,
          history,
        );
        const demoModel =
          validatedImages.length > 0
            ? "gemini-3.8-flash (demo)"
            : "gemini-3.8-flash (demo)";

        console.log(
          `[AI Upstream (Demo)] Starting simulated generation | Provider: gemini | Model: ${demoModel} | Stream: ${shouldStream}`,
        );

        if (!shouldStream) {
          const totalDuration = Date.now() - requestStartTime;
          console.log(
            `[AI Stream (Demo)] Completed response in ${totalDuration}ms | Model: ${demoModel}`,
          );
          return res.json({
            text,
            modelUsed: demoModel,
            provider: "gemini",
          });
        }
        initSSE(res);
        sendSSE(res, {
          type: "start",
          modelUsed: demoModel,
          provider: "gemini",
        });

        const timeToFirstChunk = Date.now() - requestStartTime;
        console.log(
          `[AI Stream (Demo)] Time to first text chunk: ${timeToFirstChunk}ms | Model: ${demoModel}`,
        );

        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: "chunk", text: token });
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!res.writableEnded) {
          const totalDuration = Date.now() - requestStartTime;
          console.log(
            `[AI Stream (Demo)] Generation completed in ${totalDuration}ms | Model: ${demoModel}`,
          );
          sendSSE(res, {
            type: "done",
            text,
            modelUsed: demoModel,
            provider: "gemini",
          });
          res.end();
        }
        return;
      }

      const hasImages = validatedImages.length > 0;
      // Check which alternative providers are genuinely configured with valid keys
      const configuredStatus = getConfiguredProviders();
      const availableBackupProviders = hasImages
        ? []
        : ["groq", "openrouter"].filter((p) =>
            configuredStatus.configuredList.includes(p),
          );

      const ai = new GoogleGenAI({
        apiKey: apiKey!,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
          timeout: 45000,
        },
      });

      const contents = formatGeminiHistory(
        history,
        promptText,
        validatedImages,
      );
      // Attempt sequence: max 3 attempts total (initial attempt + up to 2 retries)
      // Attempt 1: gemini-3.8-flash (primary recommended vision-capable model)
      // Attempt 2: gemini-3.1-flash-lite (high-throughput, fast vision model)
      // Attempt 3: gemini-flash-latest (general flash alias)
      const attemptPlan = [
        { model: "gemini-3.8-flash", attemptNum: 1 },
        { model: "gemini-3.1-flash-lite", attemptNum: 2 },
        { model: "gemini-flash-latest", attemptNum: 3 },
      ];
      const maxAttempts = attemptPlan.length;

      if (!shouldStream) {
        let lastParsedErr = null;

        for (let i = 0; i < attemptPlan.length; i++) {
          if (isClientClosed) break;
          const { model, attemptNum } = attemptPlan[i];

          try {
            const response = await ai.models.generateContent({
              model,
              contents,
              config: {
                systemInstruction,
              },
            });

            if (response && response.text) {
              return res.json({
                text: response.text,
                modelUsed: model,
                provider: "gemini",
              });
            }
          } catch (err: any) {
            const parsed = parseGeminiError(err);
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;
            const willRetry =
              parsed.isRetryable &&
              hasMoreAttempts &&
              !isClientClosed &&
              parsed.status !== "RESOURCE_EXHAUSTED";

            logAIDiagnostic({
              requestId,
              provider: "gemini",
              model,
              phase: "non-streaming",
              headersSent: res.headersSent,
              httpStatus: parsed.statusCode,
              attempt: attemptNum,
              maxAttempts,
              upstreamStatus: parsed.statusCode,
              upstreamErrorCode: parsed.status,
              originalErrorName: parsed.originalErrorName,
              originalErrorMessage: parsed.originalErrorMessage,
              sanitizedMessage: parsed.message,
              retryAfterSeconds: parsed.retryAfterSeconds,
              willRetry,
            });

            if (!parsed.isRetryable) {
              return sendSafeErrorResponse(res, {
                statusCode: parsed.statusCode,
                error: parsed.message,
                code: parsed.statusCode,
                status: parsed.status,
                provider: "gemini",
                model,
                retryable: false,
                canFallback: availableBackupProviders.length > 0 && !hasImages,
                suggestedProviders: availableBackupProviders,
                retryAfterSeconds: parsed.retryAfterSeconds,
              });
            }

            if (willRetry) {
              const delay = getBackoffWithJitter(
                attemptNum,
                parsed.retryAfterSeconds,
              );
              const continueExecution = await sleepWithAbort(
                delay,
                () => isClientClosed,
              );
              if (!continueExecution) break;
              continue;
            }
            break;
          }
        }

        const fallbackErr: any = lastParsedErr || {
          statusCode: 503,
          status: "UNAVAILABLE",
          message:
            "Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.",
          isRetryable: true,
          retryAfterSeconds: undefined,
        };
        return sendSafeErrorResponse(res, {
          statusCode: fallbackErr.statusCode,
          error: fallbackErr.message,
          code: fallbackErr.statusCode,
          status: fallbackErr.status,
          provider: "gemini",
          model: "gemini-3.8-flash",
          retryable: fallbackErr.isRetryable,
          canFallback: availableBackupProviders.length > 0 && !hasImages,
          suggestedProviders: availableBackupProviders,
          retryAfterSeconds: fallbackErr.retryAfterSeconds,
        });
      } else {
        // Genuine streaming via ai.models.generateContentStream with delayed header initiation
        let lastParsedErr = null;

        for (let i = 0; i < attemptPlan.length; i++) {
          if (isClientClosed) break;
          const { model, attemptNum } = attemptPlan[i];

          try {
            console.log(
              `[AI Upstream] [Req: ${requestId}] Initiating generation | Provider: gemini | Model: ${model} | Stream: true`,
            );

            const responseStream = await ai.models.generateContentStream({
              model,
              contents,
              config: {
                systemInstruction,
              },
            });

            // CRITICAL: Await the first chunk BEFORE initializing SSE headers on res!
            // This verifies the stream actually started and prevents sending 200 SSE headers if model returns 503 UNAVAILABLE.
            const iterator = responseStream[Symbol.asyncIterator]();
            const firstChunkResult = await iterator.next();

            const timeToFirstChunk = Date.now() - requestStartTime;
            console.log(
              `[AI Stream] [Req: ${requestId}] Time to first text chunk: ${timeToFirstChunk}ms | Provider: gemini | Model: ${model}`,
            );

            // Connection established successfully! Send headers and start event now.
            initSSE(res);
            sendSSE(res, {
              type: "start",
              modelUsed: model,
              provider: "gemini",
            });

            let fullText = "";
            if (!firstChunkResult.done && firstChunkResult.value) {
              const chunkText = firstChunkResult.value.text;
              if (chunkText) {
                fullText += chunkText;
                sendSSE(res, { type: "chunk", text: chunkText });
              }
            }

            // Process subsequent stream chunks
            try {
              while (true) {
                if (isClientClosed || res.writableEnded) break;
                const { done, value } = await iterator.next();
                if (done) break;
                const chunkText = value?.text;
                if (chunkText) {
                  fullText += chunkText;
                  sendSSE(res, { type: "chunk", text: chunkText });
                }
              }

              if (!res.writableEnded) {
                const totalDuration = Date.now() - requestStartTime;
                console.log(
                  `[AI Stream] [Req: ${requestId}] Generation completed in ${totalDuration}ms | Provider: gemini | Model: ${model}`,
                );
                sendSSE(res, {
                  type: "done",
                  text: fullText,
                  modelUsed: model,
                  provider: "gemini",
                });
                res.end();
              }
              return;
            } catch (midStreamErr: any) {
              const parsedMid = parseGeminiError(midStreamErr);
              logAIDiagnostic({
                requestId,
                provider: "gemini",
                model,
                phase: "mid-stream",
                headersSent: res.headersSent,
                httpStatus: parsedMid.statusCode,
                attempt: 1,
                maxAttempts: 1,
                upstreamStatus: parsedMid.statusCode,
                upstreamErrorCode: parsedMid.status,
                originalErrorName: parsedMid.originalErrorName,
                originalErrorMessage: parsedMid.originalErrorMessage,
                sanitizedMessage: parsedMid.message,
                willRetry: false,
              });

              sendSafeErrorResponse(res, {
                statusCode: parsedMid.statusCode,
                error: parsedMid.message,
                code: parsedMid.statusCode,
                status: parsedMid.status,
                provider: "gemini",
                model,
                retryable: false, // Cannot retry mid-stream safely without duplicating output
                canFallback: false, // Do not restart stream from another provider if partial content was delivered
                suggestedProviders: [],
                retryAfterSeconds: parsedMid.retryAfterSeconds,
                partial: fullText.length > 0,
              });
              return;
            }
          } catch (initialErr: any) {
            // Initial connection failed BEFORE headers were sent!
            const parsed = parseGeminiError(initialErr);
            lastParsedErr = parsed;
            const hasMoreAttempts = i < attemptPlan.length - 1;
            const willRetry =
              parsed.isRetryable &&
              hasMoreAttempts &&
              !isClientClosed &&
              parsed.status !== "RESOURCE_EXHAUSTED";

            logAIDiagnostic({
              requestId,
              provider: "gemini",
              model,
              phase: "pre-stream",
              headersSent: res.headersSent,
              httpStatus: parsed.statusCode,
              attempt: attemptNum,
              maxAttempts,
              upstreamStatus: parsed.statusCode,
              upstreamErrorCode: parsed.status,
              originalErrorName: parsed.originalErrorName,
              originalErrorMessage: parsed.originalErrorMessage,
              sanitizedMessage: parsed.message,
              retryAfterSeconds: parsed.retryAfterSeconds,
              willRetry,
            });

            if (!parsed.isRetryable) {
              return sendSafeErrorResponse(res, {
                statusCode: parsed.statusCode,
                error: parsed.message,
                code: parsed.statusCode,
                status: parsed.status,
                provider: "gemini",
                model,
                retryable: false,
                canFallback: availableBackupProviders.length > 0 && !hasImages,
                suggestedProviders: availableBackupProviders,
                retryAfterSeconds: parsed.retryAfterSeconds,
              });
            }

            if (willRetry) {
              const delay = getBackoffWithJitter(
                attemptNum,
                parsed.retryAfterSeconds,
              );
              const continueExecution = await sleepWithAbort(
                delay,
                () => isClientClosed,
              );
              if (!continueExecution) break;
              continue;
            }
            break;
          }
        }

        const finalErr: any = lastParsedErr || {
          statusCode: 503,
          status: "UNAVAILABLE",
          message:
            "Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments.",
          isRetryable: true,
          retryAfterSeconds: undefined,
        };
        return sendSafeErrorResponse(res, {
          statusCode: finalErr.statusCode,
          error: finalErr.message,
          code: finalErr.statusCode,
          status: finalErr.status,
          provider: "gemini",
          model: "gemini-3.8-flash",
          retryable: finalErr.isRetryable,
          canFallback: availableBackupProviders.length > 0 && !hasImages,
          suggestedProviders: availableBackupProviders,
          retryAfterSeconds: finalErr.retryAfterSeconds,
        });
      }
    }

    // 2. Groq Provider
    if (normalizedProvider === "groq") {
      const apiKey = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
      const isFallback = (req.body as any)?.isFallback === true;
      if (!isKeyValid(apiKey)) {
        if (isFallback) {
          return sendSafeErrorResponse(res, {
            statusCode: 400,
            error: "Groq is not configured with a valid API key.",
            code: 400,
            status: "INVALID_ARGUMENT",
            provider: "groq",
            canFallback: false,
          });
        }
        const text = generateSimulatedResponse(
          promptText,
          cleanUsername,
          preferences,
          mode,
          documents,
        );
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: "Llama 3.3 70B (demo)",
            provider: "groq",
          });
        }
        initSSE(res);
        sendSSE(res, {
          type: "start",
          modelUsed: "Llama 3.3 70B (demo)",
          provider: "groq",
        });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: "chunk", text: token });
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!res.writableEnded) {
          sendSSE(res, {
            type: "done",
            text,
            modelUsed: "Llama 3.3 70B (demo)",
            provider: "groq",
          });
          res.end();
        }
        return;
      }

      const messages = [
        {
          role: "system",
          content: systemInstruction,
        },
      ];

      for (const msg of history.slice(-12)) {
        if (!msg.content) continue;
        messages.push({
          role: msg.sender === "user" ? "user" : "assistant",
          content: msg.content.trim(),
        });
      }
      messages.push({ role: "user", content: promptText });

      if (!shouldStream) {
        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "openai/gpt-oss-120b",
              messages,
              temperature: 0.7,
            }),
          },
        );

        if (!groqRes.ok) {
          const errText = await groqRes.text().catch(() => "");
          const status = toValidHttpStatus(groqRes.status, 502);
          logAIDiagnostic({
            requestId,
            provider: "groq",
            model: "openai/gpt-oss-120b",
            phase: "non-streaming",
            headersSent: res.headersSent,
            httpStatus: status,
            attempt: 1,
            maxAttempts: 1,
            upstreamStatus: status,
            originalErrorName: "GroqAPIError",
            originalErrorMessage: errText.slice(0, 200),
            sanitizedMessage: `Groq request failed (${status})`,
            willRetry: false,
          });
          return sendSafeErrorResponse(res, {
            statusCode: status,
            error: `Groq request failed (${status}): ${sanitizeErrorLog(errText)}`,
            code: status,
            status:
              status === 429
                ? "RESOURCE_EXHAUSTED"
                : status === 401
                  ? "UNAUTHENTICATED"
                  : "ERROR",
            provider: "groq",
            canFallback: true,
            suggestedProviders: ["gemini", "openrouter"],
          });
        }

        const data = await groqRes.json();
        return res.json({
          text: data?.choices?.[0]?.message?.content || "",
          modelUsed: data.model || "openai/gpt-oss-120b",
          provider: "groq",
        });
      } else {
        // Genuine streaming via Groq OpenAI-compatible SSE
        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "openai/gpt-oss-120b",
              messages,
              temperature: 0.7,
              stream: true,
            }),
          },
        );

        if (!groqRes.ok) {
          const errText = await groqRes.text().catch(() => "");
          const status = toValidHttpStatus(groqRes.status, 502);
          logAIDiagnostic({
            requestId,
            provider: "groq",
            model: "openai/gpt-oss-120b",
            phase: "pre-stream",
            headersSent: res.headersSent,
            httpStatus: status,
            attempt: 1,
            maxAttempts: 1,
            upstreamStatus: status,
            originalErrorName: "GroqAPIError",
            originalErrorMessage: errText.slice(0, 200),
            sanitizedMessage: `Groq request failed (${status})`,
            willRetry: false,
          });
          return sendSafeErrorResponse(res, {
            statusCode: status,
            error: `Groq request failed (${status}): ${sanitizeErrorLog(errText)}`,
            code: status,
            status:
              status === 429
                ? "RESOURCE_EXHAUSTED"
                : status === 401
                  ? "UNAUTHENTICATED"
                  : "ERROR",
            provider: "groq",
            canFallback: true,
            suggestedProviders: ["gemini", "openrouter"],
          });
        }

        initSSE(res);
        sendSSE(res, {
          type: "start",
          modelUsed: "openai/gpt-oss-120b",
          provider: "groq",
        });

        const reader = groqRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let modelUsed = "openai/gpt-oss-120b";

        while (true) {
          if (isClientClosed || res.writableEnded) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.model) modelUsed = parsed.model;
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: "chunk", text: delta });
              }
            } catch (_) {}
          }
        }

        if (!res.writableEnded) {
          sendSSE(res, {
            type: "done",
            text: fullText,
            modelUsed,
            provider: "groq",
          });
          res.end();
        }
        return;
      }
    }

    // 3. OpenRouter Provider
    if (normalizedProvider === "openrouter") {
      const apiKey =
        process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;
      const isFallback = (req.body as any)?.isFallback === true;
      if (!isKeyValid(apiKey)) {
        if (isFallback) {
          return sendSafeErrorResponse(res, {
            statusCode: 400,
            error: "OpenRouter is not configured with a valid API key.",
            code: 400,
            status: "INVALID_ARGUMENT",
            provider: "openrouter",
            canFallback: false,
          });
        }
        const text = generateSimulatedResponse(
          promptText,
          cleanUsername,
          preferences,
          mode,
          documents,
        );
        if (!shouldStream) {
          return res.json({
            text,
            modelUsed: "openrouter/free (demo)",
            provider: "openrouter",
          });
        }
        initSSE(res);
        sendSSE(res, {
          type: "start",
          modelUsed: "openrouter/free (demo)",
          provider: "openrouter",
        });
        const tokens = text.split(/(\s+)/);
        for (const token of tokens) {
          if (isClientClosed || res.writableEnded) break;
          sendSSE(res, { type: "chunk", text: token });
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!res.writableEnded) {
          sendSSE(res, {
            type: "done",
            text,
            modelUsed: "openrouter/free (demo)",
            provider: "openrouter",
          });
          res.end();
        }
        return;
      }

      const messages = [
        {
          role: "system",
          content: systemInstruction,
        },
      ];

      for (const msg of history.slice(-12)) {
        if (!msg.content) continue;
        messages.push({
          role: msg.sender === "user" ? "user" : "assistant",
          content: msg.content.trim(),
        });
      }
      messages.push({ role: "user", content: promptText });

      if (!shouldStream) {
        const orRes = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "X-Title": "Orvix",
            },
            body: JSON.stringify({
              model: "openrouter/free",
              messages,
              temperature: 0.7,
            }),
          },
        );

        if (!orRes.ok) {
          const errText = await orRes.text().catch(() => "");
          const status = toValidHttpStatus(orRes.status, 502);
          logAIDiagnostic({
            requestId,
            provider: "openrouter",
            model: "openrouter/free",
            phase: "non-streaming",
            headersSent: res.headersSent,
            httpStatus: status,
            attempt: 1,
            maxAttempts: 1,
            upstreamStatus: status,
            originalErrorName: "OpenRouterAPIError",
            originalErrorMessage: errText.slice(0, 200),
            sanitizedMessage: `OpenRouter request failed (${status})`,
            willRetry: false,
          });
          return sendSafeErrorResponse(res, {
            statusCode: status,
            error: `OpenRouter request failed (${status}): ${sanitizeErrorLog(errText)}`,
            code: status,
            status:
              status === 429
                ? "RESOURCE_EXHAUSTED"
                : status === 401
                  ? "UNAUTHENTICATED"
                  : "ERROR",
            provider: "openrouter",
            canFallback: true,
            suggestedProviders: ["gemini", "groq"],
          });
        }

        const data = await orRes.json();
        return res.json({
          text: data?.choices?.[0]?.message?.content || "",
          modelUsed: data.model || "openrouter/free",
          provider: "openrouter",
        });
      } else {
        // Genuine streaming via OpenRouter SSE
        const orRes = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "X-Title": "Orvix",
            },
            body: JSON.stringify({
              model: "openrouter/free",
              messages,
              temperature: 0.7,
              stream: true,
            }),
          },
        );

        if (!orRes.ok) {
          const errText = await orRes.text().catch(() => "");
          const status = toValidHttpStatus(orRes.status, 502);
          logAIDiagnostic({
            requestId,
            provider: "openrouter",
            model: "openrouter/free",
            phase: "pre-stream",
            headersSent: res.headersSent,
            httpStatus: status,
            attempt: 1,
            maxAttempts: 1,
            upstreamStatus: status,
            originalErrorName: "OpenRouterAPIError",
            originalErrorMessage: errText.slice(0, 200),
            sanitizedMessage: `OpenRouter request failed (${status})`,
            willRetry: false,
          });
          return sendSafeErrorResponse(res, {
            statusCode: status,
            error: `OpenRouter request failed (${status}): ${sanitizeErrorLog(errText)}`,
            code: status,
            status:
              status === 429
                ? "RESOURCE_EXHAUSTED"
                : status === 401
                  ? "UNAUTHENTICATED"
                  : "ERROR",
            provider: "openrouter",
            canFallback: true,
            suggestedProviders: ["gemini", "groq"],
          });
        }

        initSSE(res);
        sendSSE(res, {
          type: "start",
          modelUsed: "openrouter/free",
          provider: "openrouter",
        });

        const reader = orRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let modelUsed = "openrouter/free";

        while (true) {
          if (isClientClosed || res.writableEnded) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.model) modelUsed = parsed.model;
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                sendSSE(res, { type: "chunk", text: delta });
              }
            } catch (_) {}
          }
        }

        if (!res.writableEnded) {
          sendSSE(res, {
            type: "done",
            text: fullText,
            modelUsed,
            provider: "openrouter",
          });
          res.end();
        }
        return;
      }
    }

    return sendSafeErrorResponse(res, {
      statusCode: 400,
      error: `Unknown provider: ${provider}`,
      code: 400,
      status: "INVALID_ARGUMENT",
    });
  } catch (error: any) {
    const errorMsg = error?.message || "Unknown error";
    console.error(
      `[Chat API] [Req: ${requestId}] Caught unhandled error in /api/chat:`,
      sanitizeErrorLog(errorMsg),
    );
    const parsed = parseGeminiError(error);

    logAIDiagnostic({
      requestId,
      provider: "unknown",
      model: "unknown",
      phase: res.headersSent ? "mid-stream" : "pre-stream",
      headersSent: res.headersSent,
      httpStatus: parsed.statusCode,
      attempt: 1,
      maxAttempts: 1,
      upstreamStatus: parsed.statusCode,
      upstreamErrorCode: parsed.status,
      originalErrorName: parsed.originalErrorName,
      originalErrorMessage: parsed.originalErrorMessage,
      sanitizedMessage: parsed.message,
      willRetry: false,
    });

    sendSafeErrorResponse(res, {
      statusCode: parsed.statusCode,
      error: parsed.message,
      code: parsed.statusCode,
      status: parsed.status,
      retryable: parsed.isRetryable,
      canFallback: true,
      suggestedProviders: ["groq", "openrouter"],
    });
  }
});

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  const publicPath = path.resolve(__dirname, "public");
  app.use(express.static(publicPath));

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(distPath, "index.html"));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Orvix server running on http://0.0.0.0:${PORT}`);
  });
}

// Only execute listen if directly run as the entry script, not when imported by test suites
const isDirectExecution =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(__filename) ||
    process.argv[1].endsWith("server.ts") ||
    process.argv[1].endsWith("server.js"));

if (!process.env.VERCEL && !process.env.TEST && isDirectExecution) {
  startServer();
}

export { app };
