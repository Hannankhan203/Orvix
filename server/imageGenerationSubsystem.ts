import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import {
  getGeminiApiKey,
  getCloudflareCredentials,
  createRequestUpstreamGuard
} from './serverConfig.ts';
import {
  authenticateRequest
} from './firebaseAuthHelper.ts';
import {
  resolveUploadIdentity,
  verifyGuestToken,
  reserveImageSlot,
  commitImageSlot,
  releaseImageSlot,
  attachQuotaHeaders,
  isProductionEnvironment,
  type QuotaIdentity,
  type QuotaReservation
} from './uploadQuotaService.ts';
import {
  fileRegistry,
  resolveUploadDirectory,
  parseImageDimensions,
  UPLOAD_DIR
} from './uploadSubsystem.ts';
import {
  uploadAttachmentToStorage,
  downloadAttachmentFromStorage,
  findAttachmentPathInStorage,
  isValidPathSegment
} from './supabaseStorageService.ts';
import { isSupabaseConfigured, getSupabaseBucket } from './supabaseClient.ts';
import { logAIDiagnostic } from './diagnosticLogger.ts';

export interface ImageGenerationRequest {
  prompt: string;
  provider?: 'gemini' | 'cloudflare' | 'auto';
  model?: string;
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  conversationId?: string;
}

export interface ImageGenerationResult {
  id: string;
  prompt: string;
  provider: 'gemini' | 'cloudflare';
  model: string;
  mimeType: string;
  format: string;
  aspectRatio: string;
  dataUrl: string;
  base64: string;
  size: number;
  dimensions?: { width: number; height: number };
  filename: string;
  createdAt: string;
  conversationId?: string;
  userId?: string | null;
  storageProvider?: 'local' | 'supabase';
  storagePath?: string;
}

export const ALLOWED_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export type AllowedAspectRatio = (typeof ALLOWED_ASPECT_RATIOS)[number];

export const ALLOWED_PROVIDERS = ['auto', 'gemini', 'cloudflare'] as const;
export type AllowedProvider = (typeof ALLOWED_PROVIDERS)[number];

// Test hook for deterministic offline testing (strictly prohibited in production)
let testCustomGenerator: ((req: ImageGenerationRequest, userId: string | null) => Promise<ImageGenerationResult | null>) | null = null;

export function setCustomImageGeneratorForTesting(
  generator: ((req: ImageGenerationRequest, userId: string | null) => Promise<ImageGenerationResult | null>) | null
): void {
  testCustomGenerator = generator;
}

export function resetImageGenerationForTesting(): void {
  testCustomGenerator = null;
}

/**
 * Validates aspect ratio parameter
 */
export function sanitizeAspectRatio(aspectRatio?: string): AllowedAspectRatio {
  if (aspectRatio && ALLOWED_ASPECT_RATIOS.includes(aspectRatio as any)) {
    return aspectRatio as AllowedAspectRatio;
  }
  return '1:1';
}

/**
 * Validates binary image buffer magic bytes against expected MIME formats.
 * Prevents disguised HTML error pages or corrupted payloads from passing as images.
 */
export function validateImageBufferMagicBytes(buffer: Buffer, mimeType: string): void {
  if (!buffer || buffer.length < 8) {
    throw new Error('Generated image payload is corrupt or too small.');
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
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

  // WEBP: RIFF....WEBP
  const isWebp =
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50;

  const normalizedMime = (mimeType || '').toLowerCase();

  if (normalizedMime.includes('png') && !isPng) {
    if (isJpeg || isWebp) return;
    throw new Error('Generated image payload does not match valid PNG magic header bytes.');
  }

  if ((normalizedMime.includes('jpeg') || normalizedMime.includes('jpg')) && !isJpeg) {
    if (isPng || isWebp) return;
    throw new Error('Generated image payload does not match valid JPEG magic header bytes.');
  }

  if (normalizedMime.includes('webp') && !isWebp) {
    if (isPng || isJpeg) return;
    throw new Error('Generated image payload does not match valid WEBP magic header bytes.');
  }

  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('Unsupported or corrupted image binary format returned by provider.');
  }
}

/**
 * Generates an image using Gemini's official @google/genai multimodal image model.
 */
async function generateWithGemini(
  prompt: string,
  aspectRatio: string,
  modelName: string | undefined,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; mimeType: string; modelUsed: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Gemini API key is not configured.');
  }

  const model = modelName || 'gemini-3.1-flash-lite-image';

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });

  if (signal?.aborted) {
    const abortErr: any = new Error('Image generation aborted by user.');
    abortErr.name = 'AbortError';
    abortErr.status = 499;
    throw abortErr;
  }

  const response = await ai.models.generateContent({
    model,
    contents: {
      parts: [
        {
          text: prompt
        }
      ]
    },
    config: {
      imageConfig: {
        aspectRatio: sanitizeAspectRatio(aspectRatio)
      }
    }
  });

  if (signal?.aborted) {
    const abortErr: any = new Error('Image generation aborted by user.');
    abortErr.name = 'AbortError';
    abortErr.status = 499;
    throw abortErr;
  }

  const candidate = response.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    if (['SAFETY', 'RECITATION', 'IMAGE_SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate.finishReason)) {
      const safetyErr: any = new Error(`The requested prompt was blocked by Gemini safety policy: ${candidate.finishReason}`);
      safetyErr.code = 'SAFETY_VIOLATION';
      safetyErr.status = 400;
      throw safetyErr;
    }
  }

  const parts = candidate?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType || 'image/png';
      const buf = Buffer.from(part.inlineData.data, 'base64');
      validateImageBufferMagicBytes(buf, mime);
      return { buffer: buf, mimeType: mime, modelUsed: model };
    }
  }

  const textExplanation = parts.map((p) => p.text).filter(Boolean).join(' ');
  if (textExplanation) {
    throw new Error(`Gemini could not generate image: ${textExplanation}`);
  }

  throw new Error('No image was returned by Gemini for this prompt.');
}

/**
 * Generates an image using Cloudflare Workers AI.
 */
async function generateWithCloudflare(
  prompt: string,
  modelName: string | undefined,
  guard: ReturnType<typeof createRequestUpstreamGuard>,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; mimeType: string; modelUsed: string }> {
  const { accountId, apiToken } = getCloudflareCredentials();
  if (!accountId || !apiToken) {
    throw new Error('Cloudflare account ID and API token are not configured.');
  }

  const model = modelName || '@cf/black-forest-labs/flux-1-schnell';
  const customBase = (process.env.ORVIX_CLOUDFLARE_BASE_URL || '').trim().replace(/\/+$/, '');
  const baseUrl = customBase || 'https://api.cloudflare.com/client/v4';
  const url = `${baseUrl}/accounts/${accountId}/ai/run/${model}`;

  if (signal?.aborted) {
    const abortErr: any = new Error('Image generation aborted by user.');
    abortErr.name = 'AbortError';
    abortErr.status = 499;
    throw abortErr;
  }

  const response = await guard.fetchUpstream(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        num_steps: 4
      }),
      signal
    },
    { provider: 'cloudflare' }
  );

  if (signal?.aborted) {
    const abortErr: any = new Error('Image generation aborted by user.');
    abortErr.name = 'AbortError';
    abortErr.status = 499;
    throw abortErr;
  }

  if (!response.ok) {
    let errBody = '';
    try {
      errBody = await response.text();
    } catch (_) {}

    let parsedMsg = '';
    try {
      const parsedJson = JSON.parse(errBody);
      if (Array.isArray(parsedJson?.errors) && parsedJson.errors.length > 0) {
        parsedMsg = parsedJson.errors.map((e: any) => e.message || String(e)).join(', ');
      }
    } catch (_) {}

    const detail = parsedMsg || errBody || response.statusText;
    if (response.status === 401 || response.status === 403) {
      const authErr: any = new Error(`Cloudflare authentication failed: ${detail}`);
      authErr.code = 'PROVIDER_AUTH_ERROR';
      authErr.status = 403;
      throw authErr;
    }
    if (response.status === 429) {
      const limitErr: any = new Error(`Cloudflare rate limit exceeded: ${detail}`);
      limitErr.code = 'RATE_LIMITED';
      limitErr.status = 429;
      throw limitErr;
    }
    throw new Error(`Cloudflare Workers AI returned HTTP ${response.status}: ${detail}`);
  }

  const rawContentType = response.headers.get('content-type') || 'image/png';
  const contentType = rawContentType.split(';')[0].trim().toLowerCase();

  if (contentType.includes('application/json')) {
    const json = (await response.json()) as any;
    if (json?.success === false && Array.isArray(json?.errors) && json.errors.length > 0) {
      const msg = json.errors.map((e: any) => e.message || JSON.stringify(e)).join(', ');
      throw new Error(`Cloudflare Workers AI error: ${msg}`);
    }
    if (json?.result?.image) {
      const buf = Buffer.from(json.result.image, 'base64');
      validateImageBufferMagicBytes(buf, 'image/png');
      return { buffer: buf, mimeType: 'image/png', modelUsed: model };
    }
    throw new Error('Cloudflare returned JSON without an image payload.');
  }

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  validateImageBufferMagicBytes(buffer, contentType || 'image/png');
  return { buffer, mimeType: contentType || 'image/png', modelUsed: model };
}

/**
 * Registers image generation and retrieval HTTP routes
 */
export function registerImageGenerationRoutes(app: express.Express): void {
  // ---------------------------------------------------------------------------
  // 1. Image Generation Endpoint: /api/generate-image
  // ---------------------------------------------------------------------------
  const generateHandler: express.RequestHandler = async (req, res) => {
    const guard = createRequestUpstreamGuard(req, res);
    let reservedSlot: QuotaReservation | null = null;
    let identity: QuotaIdentity | null = null;

    try {
      // 1. Verify Authentication & Guest Session Audit
      const authStatus = await authenticateRequest(req);
      if (authStatus.status === 'invalid') {
        guard.cleanup();
        return res.status(401).json({
          error: `Authentication failed: ${authStatus.error}`,
          code: authStatus.code || 'INVALID_TOKEN',
          status: 'UNAUTHORIZED'
        });
      }

      const userId = authStatus.userId;

      // Audit guest sessions: if guest provided X-Guest-Token or cookie, verify signature & expiration
      if (authStatus.status === 'guest') {
        let rawGuestToken: string | undefined;
        const cookieHeader = req.headers?.cookie;
        if (cookieHeader) {
          const match = cookieHeader.match(/(?:^|;\s*)orvix_guest_token=([^;]+)/);
          if (match && match[1]) {
            rawGuestToken = decodeURIComponent(match[1].trim());
          }
        }
        if (!rawGuestToken) {
          const headerToken = (req.headers?.['x-guest-token'] || req.headers?.['X-Guest-Token']) as string | undefined;
          if (headerToken && typeof headerToken === 'string') {
            rawGuestToken = headerToken.trim();
          }
        }

        if (rawGuestToken) {
          const verification = verifyGuestToken(rawGuestToken);
          if (verification.expired) {
            guard.cleanup();
            return res.status(401).json({
              error: 'Guest session has expired. Please refresh your session.',
              code: 'INVALID_GUEST_SESSION',
              status: 'UNAUTHORIZED'
            });
          }
          if (!verification.valid) {
            guard.cleanup();
            return res.status(401).json({
              error: 'Guest session token is invalid, forged, or tampered.',
              code: 'INVALID_GUEST_SESSION',
              status: 'UNAUTHORIZED'
            });
          }
        }
      }

      // Resolve Identity for Rate Limiting & Ownership Tracking
      identity = await resolveUploadIdentity(req);

      // 2. Validate Request Body Structure
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        guard.cleanup();
        return res.status(400).json({
          error: 'Invalid request body. Expected JSON object with a prompt.',
          code: 'BAD_REQUEST',
          status: 'BAD_REQUEST'
        });
      }

      const {
        prompt,
        provider: rawProvider = 'auto',
        model,
        aspectRatio = '1:1',
        conversationId
      } = req.body;

      // Validate prompt
      if (!prompt || typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length < 2) {
        guard.cleanup();
        return res.status(400).json({
          error: 'A descriptive text prompt (at least 2 characters) is required to generate an image.',
          code: 'INVALID_PROMPT',
          status: 'BAD_REQUEST'
        });
      }

      const trimmedPrompt = prompt.trim();
      if (trimmedPrompt.length > 2000) {
        guard.cleanup();
        return res.status(400).json({
          error: 'Image generation prompt cannot exceed 2000 characters.',
          code: 'PROMPT_TOO_LONG',
          status: 'BAD_REQUEST'
        });
      }

      // Validate provider parameter
      if (rawProvider && !ALLOWED_PROVIDERS.includes(rawProvider)) {
        guard.cleanup();
        return res.status(400).json({
          error: `Invalid provider '${rawProvider}'. Supported providers: ${ALLOWED_PROVIDERS.map((p) => `'${p}'`).join(', ')}.`,
          code: 'INVALID_PROVIDER',
          status: 'BAD_REQUEST'
        });
      }

      // Validate aspect ratio parameter
      if (aspectRatio && !ALLOWED_ASPECT_RATIOS.includes(aspectRatio)) {
        guard.cleanup();
        return res.status(400).json({
          error: `Invalid aspect ratio '${aspectRatio}'. Supported aspect ratios: ${ALLOWED_ASPECT_RATIOS.map((r) => `'${r}'`).join(', ')}.`,
          code: 'INVALID_ASPECT_RATIO',
          status: 'BAD_REQUEST'
        });
      }

      // 3. Enforce Rate Limiting via Distributed Atomic Firestore Quota
      const reservationResult = await reserveImageSlot(identity);
      if (!reservationResult.allowed) {
        guard.cleanup();
        attachQuotaHeaders(
          res,
          { limit: reservationResult.limit, remaining: 0, resetAt: reservationResult.resetAt },
          identity
        );
        return res.status(429).json({
          error: reservationResult.error,
          code: 'IMAGE_QUOTA_EXCEEDED',
          status: 'RESOURCE_EXHAUSTED',
          limit: reservationResult.limit,
          remaining: 0,
          resetAt: reservationResult.resetAt
        });
      }

      reservedSlot = reservationResult.reservation;

      // 4. Offline Test Verification Hook (Strictly rejected in production)
      if (testCustomGenerator && !isProductionEnvironment()) {
        try {
          const testResult = await testCustomGenerator(
            { prompt: trimmedPrompt, provider: rawProvider, model, aspectRatio, conversationId },
            userId
          );
          if (testResult) {
            const commitStatus = await commitImageSlot(reservedSlot);
            reservedSlot = null;
            attachQuotaHeaders(res, commitStatus, identity);
            guard.cleanup();
            return res.status(200).json({
              success: true,
              ...testResult
            });
          }
        } catch (testErr: any) {
          if (reservedSlot) {
            await releaseImageSlot(reservedSlot).catch(() => {});
            reservedSlot = null;
          }
          guard.cleanup();
          return res.status(testErr.status || 500).json({
            error: testErr.message || 'Image generation failed',
            code: testErr.code || 'GENERATION_FAILED',
            status: testErr.statusText || 'ERROR'
          });
        }
      }

      // 5. Resolve Provider & Configuration
      const geminiKey = getGeminiApiKey();
      const { accountId: cfAccountId, apiToken: cfToken } = getCloudflareCredentials();
      const geminiAvailable = Boolean(geminiKey);
      const cloudflareAvailable = Boolean(cfAccountId && cfToken);

      if (rawProvider === 'gemini' && !geminiAvailable) {
        if (reservedSlot) {
          await releaseImageSlot(reservedSlot).catch(() => {});
          reservedSlot = null;
        }
        guard.cleanup();
        return res.status(503).json({
          error: 'Gemini image generation is not configured on this server (missing GEMINI_API_KEY).',
          code: 'PROVIDER_NOT_CONFIGURED',
          status: 'PROVIDER_NOT_CONFIGURED',
          provider: 'gemini',
          retryable: false
        });
      }

      if (rawProvider === 'cloudflare' && !cloudflareAvailable) {
        if (reservedSlot) {
          await releaseImageSlot(reservedSlot).catch(() => {});
          reservedSlot = null;
        }
        guard.cleanup();
        return res.status(503).json({
          error: 'Cloudflare Workers AI image generation is not configured on this server (missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN).',
          code: 'PROVIDER_NOT_CONFIGURED',
          status: 'PROVIDER_NOT_CONFIGURED',
          provider: 'cloudflare',
          retryable: false
        });
      }

      if (!geminiAvailable && !cloudflareAvailable) {
        if (reservedSlot) {
          await releaseImageSlot(reservedSlot).catch(() => {});
          reservedSlot = null;
        }
        guard.cleanup();
        return res.status(503).json({
          error: 'No image generation provider is currently configured on this server. Configure GEMINI_API_KEY or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
          code: 'PROVIDER_NOT_CONFIGURED',
          status: 'PROVIDER_NOT_CONFIGURED',
          retryable: false
        });
      }

      // 6. Execute Provider Request with Intelligent Fallback in Auto Mode
      let effectiveProvider: 'gemini' | 'cloudflare';
      let generated: { buffer: Buffer; mimeType: string; modelUsed: string };

      if (rawProvider === 'gemini') {
        effectiveProvider = 'gemini';
        generated = await guard.callGeminiWithGuard(
          (signal) => generateWithGemini(trimmedPrompt, aspectRatio, model, signal),
          { provider: 'gemini', headersTimeoutMs: 60000 }
        );
      } else if (rawProvider === 'cloudflare') {
        effectiveProvider = 'cloudflare';
        generated = await generateWithCloudflare(trimmedPrompt, model, guard);
      } else {
        // 'auto' mode: Prefer Gemini, fallback to Cloudflare if Gemini encounters quota/transient failure
        if (geminiAvailable) {
          try {
            effectiveProvider = 'gemini';
            generated = await guard.callGeminiWithGuard(
              (signal) => generateWithGemini(trimmedPrompt, aspectRatio, model, signal),
              { provider: 'gemini', headersTimeoutMs: 60000 }
            );
          } catch (geminiErr: any) {
            if (cloudflareAvailable) {
              console.warn('[ImageGeneration] Gemini generation failed in auto mode, falling back to Cloudflare Workers AI:', geminiErr?.message);
              effectiveProvider = 'cloudflare';
              generated = await generateWithCloudflare(trimmedPrompt, model, guard);
            } else {
              throw geminiErr;
            }
          }
        } else {
          effectiveProvider = 'cloudflare';
          generated = await generateWithCloudflare(trimmedPrompt, model, guard);
        }
      }

      // 7. Structure Output and Persist to Supabase and Local Cache
      const imgBuffer = generated.buffer;
      const mime = generated.mimeType || 'image/png';
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png';
      const format = ext.replace('.', '');
      const imageId = crypto.randomUUID();
      const safePromptSlug =
        trimmedPrompt
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 30)
          .replace(/^-+|-+$/g, '') || 'generated-image';
      const filename = `${safePromptSlug}-${Date.now()}${ext}`;
      const dimensions = parseImageDimensions(imgBuffer, ext);
      const base64Str = imgBuffer.toString('base64');
      const dataUrl = `data:${mime};base64,${base64Str}`;

      const sanitizedChatId = conversationId && isValidPathSegment(conversationId)
        ? conversationId
        : 'default';

      let storageProvider: 'local' | 'supabase' = 'local';
      let storagePath: string | undefined;
      let storageBucket: string | undefined;

      // Persist to Supabase private attachment storage when authenticated & configured
      if (userId && isSupabaseConfigured()) {
        try {
          const supaRes = await uploadAttachmentToStorage({
            userId,
            chatId: sanitizedChatId,
            attachmentId: imageId,
            extension: ext.replace(/^\.+/, ''),
            buffer: imgBuffer,
            mimeType: mime
          });
          if (supaRes && supaRes.success && supaRes.path) {
            storageProvider = 'supabase';
            storagePath = supaRes.path;
            storageBucket = supaRes.bucket;
          }
        } catch (supaErr) {
          console.warn('[ImageGeneration] Supabase storage upload warning:', supaErr);
        }
      }

      // Cache locally on filesystem and in-memory registry
      try {
        const uploadDir = resolveUploadDirectory();
        const diskPath = path.join(uploadDir, `${imageId}${ext}`);
        fs.writeFileSync(diskPath, imgBuffer);

        fileRegistry.set(imageId, {
          id: imageId,
          originalName: filename,
          diskFilename: `${imageId}${ext}`,
          filename: `${imageId}${ext}`,
          mimeType: mime,
          extension: ext,
          size: imgBuffer.length,
          formattedSize: `${Math.round(imgBuffer.length / 1024)} KB`,
          status: 'ready',
          uploadedAt: new Date().toISOString(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          isImage: true,
          dimensions: dimensions ? { width: dimensions.width, height: dimensions.height } : undefined,
          storageProvider,
          storagePath,
          storageBucket,
          path: diskPath,
          conversationId: sanitizedChatId,
          userId: userId || undefined
        });
      } catch (saveErr) {
        console.warn('[ImageGeneration] Disk cache warning:', saveErr);
      }

      // Commit quota reservation
      const quotaStatus = await commitImageSlot(reservedSlot);
      reservedSlot = null;
      attachQuotaHeaders(res, quotaStatus, identity);

      guard.cleanup();

      const result: ImageGenerationResult = {
        id: imageId,
        prompt: trimmedPrompt,
        provider: effectiveProvider,
        model: generated.modelUsed,
        mimeType: mime,
        format,
        aspectRatio: sanitizeAspectRatio(aspectRatio),
        dataUrl,
        base64: base64Str,
        size: imgBuffer.length,
        dimensions,
        filename,
        createdAt: new Date().toISOString(),
        conversationId: sanitizedChatId,
        userId: userId || null,
        storageProvider,
        storagePath
      };

      return res.status(200).json({
        success: true,
        ...result
      });
    } catch (err: any) {
      if (reservedSlot) {
        await releaseImageSlot(reservedSlot).catch(() => {});
        reservedSlot = null;
      }
      guard.cleanup();

      if (identity && identity.type === 'guest' && identity.guestToken) {
        try {
          res.setHeader('X-Guest-Token', identity.guestToken);
          res.setHeader(
            'Set-Cookie',
            `orvix_guest_token=${encodeURIComponent(identity.guestToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
          );
        } catch (_) {}
      }

      const errMsg = err?.message || String(err);
      logAIDiagnostic({
        category: 'image generation error',
        provider: (req.body?.provider as string) || 'gemini',
        phase: 'generation',
        upstreamStatus: err.status || 500,
        upstreamErrorCode: err.code || 'IMAGE_GENERATION_FAILED',
        sanitizedMessage: errMsg,
        willRetry: false
      });

      if (errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota') || errMsg.includes('Free Tier') || err.status === 429) {
        return res.status(429).json({
          error: 'Gemini image generation quota exceeded. Configure a billing-enabled API key or use Cloudflare Workers AI.',
          code: 'QUOTA_EXCEEDED',
          status: 'RESOURCE_EXHAUSTED',
          retryable: false
        });
      }

      if (errMsg.includes('SAFETY') || errMsg.includes('blocked') || err.code === 'SAFETY_VIOLATION') {
        return res.status(400).json({
          error: 'The requested prompt was blocked by AI safety policies. Please rephrase your prompt.',
          code: 'SAFETY_VIOLATION',
          status: 'BAD_REQUEST',
          retryable: false
        });
      }

      if (err.name === 'AbortError' || err.status === 499) {
        return res.status(499).json({
          error: 'Image generation was cancelled by the client.',
          code: 'CLIENT_CLOSED_REQUEST',
          status: 'CLIENT_CLOSED_REQUEST'
        });
      }

      if (err.isUpstreamHeadersTimeout || err.code === 'DEADLINE_EXCEEDED') {
        return res.status(504).json({
          error: 'Image generation timed out waiting for provider response. Please try again.',
          code: 'DEADLINE_EXCEEDED',
          status: 'GATEWAY_TIMEOUT',
          retryable: true
        });
      }

      return res.status(err.status || 500).json({
        error: errMsg || 'An unexpected error occurred while generating the image.',
        code: err.code || 'GENERATION_FAILED',
        status: 'SERVER_ERROR',
        retryable: true
      });
    }
  };

  app.post(['/api/generate-image', '/api/image/generate', '/api/images/generate'], generateHandler);

  // ---------------------------------------------------------------------------
  // 2. Dedicated Generated Image File Serving & Download Endpoint
  //    Handles in-memory, local disk, and post-restart Supabase downloads with ownership checks
  // ---------------------------------------------------------------------------
  const downloadHandler: express.RequestHandler = async (req, res) => {
    const fileId = req.params.id;
    if (!fileId || (!/^[0-9a-fA-F-]{36}$/.test(fileId) && !/^gen-[a-zA-Z0-9_-]{10,80}$/.test(fileId))) {
      return res.status(400).json({ error: 'Invalid image ID format.', code: 'INVALID_ID_FORMAT' });
    }

    const rawChatId = (typeof req.query.chatId === 'string' ? req.query.chatId : '').trim() || 'default';
    const record = fileRegistry.get(fileId);

    if (record) {
      let authenticatedUserId: string | null = null;
      if (record.storageProvider === 'supabase' || record.userId) {
        const authStatus = await authenticateRequest(req);
        if (authStatus.status === 'invalid') {
          return res.status(401).json({
            error: `Authentication failed: ${authStatus.error}`,
            code: authStatus.code || 'INVALID_TOKEN'
          });
        }
        if (authStatus.status === 'guest') {
          return res.status(401).json({
            error: 'Authentication required to access this generated image.',
            code: 'AUTH_REQUIRED'
          });
        }
        if (authStatus.userId !== record.userId) {
          return res.status(403).json({
            error: 'Access denied: You do not have permission to access images belonging to another user.',
            code: 'STORAGE_ACCESS_DENIED'
          });
        }
        authenticatedUserId = authStatus.userId;
      }

      const mimeType = record.mimeType || 'image/png';
      const originalName = record.originalName || `${fileId}.png`;
      const safeFilename = path.basename(originalName).replace(/[/\\?%*:|"<>]/g, '_');
      const forceDownload = req.query.download === 'true' || req.path.includes('/download');

      res.setHeader('Content-Type', mimeType);
      res.setHeader(
        'Content-Disposition',
        `${forceDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
      );

      // Supabase retrieval
      if (record.storageProvider === 'supabase' && record.storagePath) {
        try {
          const downloadResult = await downloadAttachmentFromStorage(record.storagePath, {
            requestingUserId: authenticatedUserId || undefined,
            bucket: record.storageBucket
          });
          if (downloadResult.success && downloadResult.data) {
            return res.send(downloadResult.data);
          }
        } catch (_) {}
      }

      // Memory buffer
      if (record.buffer) {
        return res.send(record.buffer);
      }

      // Disk fallback
      if (record.path && fs.existsSync(record.path)) {
        return res.sendFile(path.resolve(record.path));
      }
      if (record.diskFilename) {
        const diskPath = path.resolve(UPLOAD_DIR, path.basename(record.diskFilename));
        if (fs.existsSync(diskPath)) {
          return res.sendFile(diskPath);
        }
      }

      return res.status(404).json({ error: 'Generated image not found or has expired.', code: 'IMAGE_NOT_FOUND' });
    }

    // Record NOT found in memory (e.g. server restart or serverless instance)
    // Retrieve persistently from private Supabase Storage
    const authStatus = await authenticateRequest(req);
    if (authStatus.status === 'invalid') {
      return res.status(401).json({
        error: `Authentication failed: ${authStatus.error}`,
        code: authStatus.code || 'INVALID_TOKEN'
      });
    }
    if (authStatus.status === 'guest') {
      return res.status(401).json({
        error: 'Authentication required to access this image.',
        code: 'AUTH_REQUIRED'
      });
    }

    const authenticatedUserId = authStatus.userId;
    if (!isSupabaseConfigured()) {
      return res.status(404).json({
        error: 'Image file not found or has expired.',
        code: 'IMAGE_NOT_FOUND'
      });
    }

    const lookup = await findAttachmentPathInStorage(authenticatedUserId, rawChatId, fileId);
    if (!lookup.found || !lookup.path) {
      return res.status(404).json({
        error: 'Image file not found in persistent storage.',
        code: 'IMAGE_NOT_FOUND'
      });
    }

    const downloadResult = await downloadAttachmentFromStorage(lookup.path, {
      requestingUserId: authenticatedUserId
    });

    if (!downloadResult.success || !downloadResult.data) {
      if (downloadResult.status === 403 || downloadResult.code === 'STORAGE_ACCESS_DENIED') {
        return res.status(403).json({
          error: 'Access denied: You do not have permission to access images belonging to another user.',
          code: 'STORAGE_ACCESS_DENIED'
        });
      }
      return res.status(404).json({
        error: 'Image file not found.',
        code: 'IMAGE_NOT_FOUND'
      });
    }

    const ext = path.extname(lookup.path) || '.png';
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    const safeFilename = `${fileId}${ext}`;
    const forceDownload = req.query.download === 'true' || req.path.includes('/download');

    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `${forceDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );

    return res.send(downloadResult.data);
  };

  app.get(
    [
      '/api/image/:id/download',
      '/api/image/:id/file',
      '/api/images/:id/download',
      '/api/images/:id/file'
    ],
    downloadHandler
  );
}
