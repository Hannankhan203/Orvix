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
  fileRegistry,
  resolveUploadDirectory,
  parseImageDimensions
} from './uploadSubsystem.ts';
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
}

// Test hook for deterministic offline testing
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
export function sanitizeAspectRatio(aspectRatio?: string): '1:1' | '3:4' | '4:3' | '9:16' | '16:9' {
  const allowed = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
  if (aspectRatio && allowed.includes(aspectRatio as any)) {
    return aspectRatio as any;
  }
  return '1:1';
}

/**
 * Generates an image using Gemini's official @google/genai multimodal image model.
 */
async function generateWithGemini(
  prompt: string,
  aspectRatio: string,
  modelName: string | undefined
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

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      imageConfig: {
        aspectRatio: sanitizeAspectRatio(aspectRatio)
      }
    }
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType || 'image/png';
      const buf = Buffer.from(part.inlineData.data, 'base64');
      return { buffer: buf, mimeType: mime, modelUsed: model };
    }
  }

  throw new Error('No image was returned by Gemini for this prompt.');
}

/**
 * Generates an image using Cloudflare Workers AI.
 */
async function generateWithCloudflare(
  prompt: string,
  modelName: string | undefined,
  guard: ReturnType<typeof createRequestUpstreamGuard>
): Promise<{ buffer: Buffer; mimeType: string; modelUsed: string }> {
  const { accountId, apiToken } = getCloudflareCredentials();
  if (!accountId || !apiToken) {
    throw new Error('Cloudflare account ID and API token are not configured.');
  }

  const model = modelName || '@cf/black-forest-labs/flux-1-schnell';
  const customBase = (process.env.ORVIX_CLOUDFLARE_BASE_URL || '').trim().replace(/\/+$/, '');
  const baseUrl = customBase || 'https://api.cloudflare.com/client/v4';
  const url = `${baseUrl}/accounts/${accountId}/ai/run/${model}`;

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
      })
    },
    { provider: 'cloudflare' }
  );

  if (!response.ok) {
    let errBody = '';
    try {
      errBody = await response.text();
    } catch (_) {}
    throw new Error(`Cloudflare Workers AI returned HTTP ${response.status}: ${errBody || response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || 'image/png';

  if (contentType.includes('application/json')) {
    const json = (await response.json()) as any;
    if (json?.result?.image) {
      const buf = Buffer.from(json.result.image, 'base64');
      return { buffer: buf, mimeType: 'image/png', modelUsed: model };
    }
    throw new Error('Cloudflare returned JSON without an image payload.');
  }

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  return { buffer, mimeType: contentType, modelUsed: model };
}

/**
 * Registers image generation HTTP routes
 */
export function registerImageGenerationRoutes(app: express.Express): void {
  const handler: express.RequestHandler = async (req, res) => {
    const guard = createRequestUpstreamGuard(req, res);

    try {
      // 1. Authenticate request (verifies Firebase token if present, rejects forged tokens)
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

      // 2. Validate Prompt
      const {
        prompt,
        provider: rawProvider = 'auto',
        model,
        aspectRatio = '1:1',
        conversationId
      } = req.body || {};

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        guard.cleanup();
        return res.status(400).json({
          error: 'A descriptive text prompt is required to generate an image.',
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

      // Check test hook first for automated offline test verification
      if (testCustomGenerator) {
        try {
          const testResult = await testCustomGenerator(
            { prompt: trimmedPrompt, provider: rawProvider, model, aspectRatio, conversationId },
            userId
          );
          if (testResult) {
            guard.cleanup();
            return res.status(200).json(testResult);
          }
        } catch (testErr: any) {
          guard.cleanup();
          return res.status(testErr.status || 500).json({
            error: testErr.message || 'Image generation failed',
            code: testErr.code || 'GENERATION_FAILED',
            status: testErr.statusText || 'ERROR'
          });
        }
      }

      // 3. Resolve Provider
      const geminiKey = getGeminiApiKey();
      const { accountId: cfAccountId, apiToken: cfToken } = getCloudflareCredentials();
      const geminiAvailable = Boolean(geminiKey);
      const cloudflareAvailable = Boolean(cfAccountId && cfToken);

      let effectiveProvider: 'gemini' | 'cloudflare';

      if (rawProvider === 'gemini') {
        if (!geminiAvailable) {
          guard.cleanup();
          return res.status(503).json({
            error: 'Gemini image generation is not configured on this server (missing GEMINI_API_KEY).',
            code: 'PROVIDER_NOT_CONFIGURED',
            status: 'PROVIDER_NOT_CONFIGURED',
            provider: 'gemini',
            retryable: false
          });
        }
        effectiveProvider = 'gemini';
      } else if (rawProvider === 'cloudflare') {
        if (!cloudflareAvailable) {
          guard.cleanup();
          return res.status(503).json({
            error: 'Cloudflare Workers AI image generation is not configured on this server (missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN).',
            code: 'PROVIDER_NOT_CONFIGURED',
            status: 'PROVIDER_NOT_CONFIGURED',
            provider: 'cloudflare',
            retryable: false
          });
        }
        effectiveProvider = 'cloudflare';
      } else {
        // Auto-select: prefer Gemini if available, else Cloudflare
        if (geminiAvailable) {
          effectiveProvider = 'gemini';
        } else if (cloudflareAvailable) {
          effectiveProvider = 'cloudflare';
        } else {
          guard.cleanup();
          return res.status(503).json({
            error: 'No image generation provider is currently configured on this server. Please configure GEMINI_API_KEY or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
            code: 'PROVIDER_NOT_CONFIGURED',
            status: 'PROVIDER_NOT_CONFIGURED',
            retryable: false
          });
        }
      }

      // 4. Generate Image with upstream guard
      let generated: { buffer: Buffer; mimeType: string; modelUsed: string };

      if (effectiveProvider === 'gemini') {
        try {
          generated = await guard.callGeminiWithGuard(
            () => generateWithGemini(trimmedPrompt, aspectRatio, model),
            { provider: 'gemini', headersTimeoutMs: 60000 }
          );
        } catch (geminiErr: any) {
          const errMsg = geminiErr?.message || String(geminiErr);
          logAIDiagnostic({
            category: 'image generation error',
            provider: 'gemini',
            phase: 'generation',
            upstreamStatus: 500,
            upstreamErrorCode: 'IMAGE_GENERATION_FAILED',
            sanitizedMessage: errMsg,
            willRetry: false
          });

          // Check if quota / billing limit hit
          if (
            errMsg.includes('RESOURCE_EXHAUSTED') ||
            errMsg.includes('quota') ||
            errMsg.includes('Free Tier') ||
            errMsg.includes('429')
          ) {
            guard.cleanup();
            return res.status(429).json({
              error:
                'Gemini image generation requires a billing-enabled API key or currently has no available quota. Configure a paid Gemini API key or use Cloudflare Workers AI.',
              code: 'QUOTA_EXCEEDED',
              status: 'RESOURCE_EXHAUSTED',
              provider: 'gemini',
              retryable: false
            });
          }

          // Check safety block
          if (errMsg.includes('SAFETY') || errMsg.includes('blocked')) {
            guard.cleanup();
            return res.status(400).json({
              error: 'The requested prompt was blocked by AI safety policies. Please rephrase your prompt.',
              code: 'SAFETY_VIOLATION',
              status: 'BAD_REQUEST',
              provider: 'gemini',
              retryable: false
            });
          }

          guard.cleanup();
          return res.status(500).json({
            error: `Gemini image generation failed: ${errMsg}`,
            code: 'GENERATION_FAILED',
            status: 'SERVER_ERROR',
            provider: 'gemini',
            retryable: true
          });
        }
      } else {
        try {
          generated = await generateWithCloudflare(trimmedPrompt, model, guard);
        } catch (cfErr: any) {
          const errMsg = cfErr?.message || String(cfErr);
          logAIDiagnostic({
            category: 'image generation error',
            provider: 'cloudflare',
            phase: 'generation',
            upstreamStatus: 500,
            upstreamErrorCode: 'IMAGE_GENERATION_FAILED',
            sanitizedMessage: errMsg,
            willRetry: false
          });

          guard.cleanup();
          return res.status(500).json({
            error: `Cloudflare Workers AI image generation failed: ${errMsg}`,
            code: 'GENERATION_FAILED',
            status: 'SERVER_ERROR',
            provider: 'cloudflare',
            retryable: true
          });
        }
      }

      // 5. Structure Output & Persist to Local Attachment Storage
      const imgBuffer = generated.buffer;
      const mime = generated.mimeType || 'image/png';
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png';
      const format = ext.replace('.', '');
      const imageId = `gen-img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const safePromptSlug = trimmedPrompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 30)
        .replace(/^-+|-+$/g, '') || 'generated-image';
      const filename = `${safePromptSlug}-${Date.now()}${ext}`;

      const dimensions = parseImageDimensions(imgBuffer, ext);
      const base64Str = imgBuffer.toString('base64');
      const dataUrl = `data:${mime};base64,${base64Str}`;

      // Persist to local filesystem upload cache so it can also be retrieved via /api/upload/:id/file
      try {
        const uploadDir = resolveUploadDirectory();
        const diskPath = path.join(uploadDir, `${imageId}${ext}`);
        fs.writeFileSync(diskPath, imgBuffer);

        fileRegistry.set(imageId, {
          id: imageId,
          originalName: filename,
          filename: `${imageId}${ext}`,
          mimeType: mime,
          size: imgBuffer.length,
          uploadedAt: new Date(),
          path: diskPath,
          conversationId: conversationId || undefined,
          userId: userId || undefined
        });
      } catch (saveErr) {
        console.warn('[ImageGeneration] Could not persist to local disk cache:', saveErr);
      }

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
        conversationId,
        userId: userId || null
      };

      return res.status(200).json({
        success: true,
        ...result
      });
    } catch (err: any) {
      guard.cleanup();
      console.error('[ImageGeneration] Unexpected error:', err);
      return res.status(500).json({
        error: err?.message || 'An unexpected error occurred while generating image.',
        code: 'INTERNAL_ERROR',
        status: 'SERVER_ERROR'
      });
    }
  };

  app.post(['/api/generate-image', '/api/image/generate', '/api/images/generate'], handler);
}
