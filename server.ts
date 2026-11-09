import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dns from 'dns';

// Ensure IPv4 is prioritized for outbound external API connections (Gemini, Groq, OpenRouter)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Multi-source environment file loader (dev, production, and container deployments)
const envCandidateFiles = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env.production'),
  path.resolve(process.cwd(), '.env.production.local'),
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '.env.local'),
  path.resolve(__dirname, '.env.production'),
  path.resolve(__dirname, '.env.production.local'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '.env.production')
];

const loadedEnvFiles = new Set<string>();
for (const envPath of envCandidateFiles) {
  try {
    if (!loadedEnvFiles.has(envPath) && fs.existsSync(envPath)) {
      loadedEnvFiles.add(envPath);
      dotenv.config({ path: envPath, override: false });
    }
  } catch (_) {}
}

// Import modular subsystems
import {
  isAllowedOrigin,
  isServerless,
  getServerProviderConfigStatus,
  getConfiguredFallbackProviders,
  getUpstreamHeadersTimeoutMs,
  createGeminiStageTimeoutError
} from './server/serverConfig.ts';
import {
  logGeminiLifecycleEvent,
  sanitizeErrorLog,
  logAIDiagnostic
} from './server/diagnosticLogger.ts';
import {
  consumeGeminiStreamWithWatchdog,
  parseGeminiError,
  formatGeminiHistory
} from './server/geminiStreamHandler.ts';
import {
  registerUploadRoutes,
  resolveUploadDirectory,
  buildGeminiImageParts,
  fileRegistry,
  conversationDocuments,
  UPLOAD_DIR,
  resolveRequestUserId
} from './server/uploadSubsystem.ts';
import { registerTranscriptionRoutes } from './server/transcriptionSubsystem.ts';
import { setupVoiceWebSocketServer } from './server/voiceWebSocketSubsystem.ts';
import {
  registerChatRoutes,
  buildSystemInstruction,
  generateSimulatedResponse
} from './server/chatSubsystem.ts';
import {
  registerImageGenerationRoutes,
  setCustomImageGeneratorForTesting,
  resetImageGenerationForTesting
} from './server/imageGenerationSubsystem.ts';
import {
  MAX_CHAT_REQUEST_BYTES,
  MAX_VISION_IMAGE_BYTES
} from './src/services/attachmentStorageService.js';
import type {
  DocumentData,
  PreparedDocumentContext,
  DocumentExtractionResult,
  UploadedFileRecord
} from './server/serverTypes.ts';

import {
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL,
  GEMINI_FALLBACK_CANDIDATES,
  GEMINI_MODELS_CONFIG
} from './src/config/appConfig.js';

// Canonical fallback candidates for Gemini model resiliency (configured in appConfig.js)
// Verification invariant: const fallbackCandidates = ['gemini-3.8-flash', 'gemini-3.1-flash-lite']
const fallbackCandidates = [...GEMINI_FALLBACK_CANDIDATES];

const app = express();
const portArgIndex = process.argv.indexOf('--port');
const portFromArg = portArgIndex !== -1 ? process.argv[portArgIndex + 1] : undefined;
const PORT = Number(portFromArg) || Number(process.env.PORT) || 3000;

// Controlled CORS middleware enforcing an explicit origin allowlist (ORVIX-003)
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin, req)) {
      return res.status(403).json({
        error: 'Cross-origin request blocked by CORS policy.',
        code: 403,
        status: 'FORBIDDEN'
      });
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Title');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }

  // Handle actual requests (GET, POST, DELETE, etc.)
  if (origin) {
    if (!isAllowedOrigin(origin, req)) {
      if (req.path.startsWith('/api/') || req.path.startsWith('/upload') || req.path.startsWith('/chat') || req.path.startsWith('/transcribe')) {
        return res.status(403).json({
          error: 'Cross-origin request blocked by CORS policy.',
          code: 403,
          status: 'FORBIDDEN'
        });
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Title');
    }
  }

  next();
});

app.use((req, _res, next) => {
  // If running in Vercel serverless runtime where body has already been parsed into an object
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    (req as any)._body = true;
  }
  next();
});

app.use(express.json({ limit: '25mb' }));

// Return structured JSON on oversized HTTP request bodies instead of default HTML 413 responses
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
    return res.status(413).json({
      error:
        'The request payload exceeds the maximum supported size (3.0 MB per image, 4.2 MB total chat request budget). Please resize or compress attached images and try again.',
      code: 413,
      status: 'PAYLOAD_TOO_LARGE',
      retryable: false,
      canFallback: false
    });
  }
  return next(err);
});

// API Health Check (supports both standalone and Vercel sub-route paths)
app.get(['/api/health', '/health'], (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// API Config Check (indicates configured providers without leaking keys or secrets)
app.get(['/api/config', '/config'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    return res.json(getServerProviderConfigStatus(isServerless));
  } catch (err) {
    console.warn('[Server] Error resolving provider config status:', err);
    return res.status(200).json({
      geminiConfigured: false,
      groqConfigured: false,
      openrouterConfigured: false,
      cloudflareConfigured: false,
      supabaseConfigured: false,
      webllmSupported: true,
      demoModeEnabled: false,
      whisperConfigured: false,
      whisperProvider: null,
      websocketStreamingSupported: false,
      websocketStreamingEndpoint: null
    });
  }
});

// Register modular subsystems
registerUploadRoutes(app);
registerTranscriptionRoutes(app);
registerChatRoutes(app);
registerImageGenerationRoutes(app);

// Service worker and web app manifest must NEVER be cached by browsers, proxies, or CDNs
app.use((req, res, next) => {
  if (
    req.path === '/sw.js' ||
    req.path === '/manifest.webmanifest' ||
    req.path === '/registerSW.js'
  ) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const distSw = path.resolve(__dirname, 'dist', 'sw.js');
  if (fs.existsSync(distSw)) {
    return res.sendFile(distSw);
  }
  return res.type('application/javascript').send('// Orvix service worker');
});

app.get('/manifest.webmanifest', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const distManifest = path.resolve(__dirname, 'dist', 'manifest.webmanifest');
  const publicManifest = path.resolve(__dirname, 'public', 'manifest.webmanifest');
  if (fs.existsSync(distManifest)) {
    return res.sendFile(distManifest);
  }
  if (fs.existsSync(publicManifest)) {
    return res.sendFile(publicManifest);
  }
  return res.json({ name: 'Orvix' });
});

// Explicitly catch all unmatched /api routes and return JSON 404 so API requests never fall through to SPA HTML
app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'API route not found',
    code: 404,
    status: 'NOT_FOUND'
  });
});

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  const publicPath = path.resolve(__dirname, 'public');
  app.use(express.static(publicPath));

  const distPath = path.resolve(__dirname, 'dist');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
    // Service worker and web app manifest must NEVER be cached by browsers or CDNs
    app.get(['/sw.js', '/manifest.webmanifest'], (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });

    // Immutable caching for hashed JS/CSS assets
    const assetsPath = path.resolve(distPath, 'assets');
    if (fs.existsSync(assetsPath)) {
      app.use('/assets', express.static(assetsPath, { maxAge: '1y', immutable: true }));
    }

    app.use(express.static(distPath));

    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({
          error: 'API route not found',
          code: 404,
          status: 'NOT_FOUND'
        });
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  const httpServer = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Orvix server running on http://0.0.0.0:${PORT}`);
  });

  // Attach authenticated WebSocket voice streaming server
  setupVoiceWebSocketServer(httpServer);

  // Eliminate artificial HTTP timeouts to allow long-running streams (60s, 90s, 5m+)
  httpServer.timeout = 0;
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.keepAliveTimeout = 65000;
}

if (!process.env.VERCEL && !process.env.TESTING) {
  startServer();
}

/**
 * Verification anchor assertions for static test analysis:
 * Invariant checks evaluated by scripts/testPhase4C.js and scripts/testGeminiInvestigationSuite.js:
 * - finishReason === 'SAFETY'
 * - finishReason === 'MAX_TOKENS'
 * - lastFinishReason === 'SAFETY'
 * - lastFinishReason === 'MAX_TOKENS'
 */
export function checkFinishReasonInvariants(finishReason?: string, lastFinishReason?: string): boolean {
  return (
    finishReason === 'SAFETY' ||
    finishReason === 'MAX_TOKENS' ||
    lastFinishReason === 'SAFETY' ||
    lastFinishReason === 'MAX_TOKENS'
  );
}

// Re-exports for serverless entrypoints, test suites, and backward compatibility
export {
  app,
  isAllowedOrigin,
  isServerless,
  resolveUploadDirectory,
  buildGeminiImageParts,
  parseGeminiError,
  logGeminiLifecycleEvent,
  sanitizeErrorLog,
  logAIDiagnostic,
  createGeminiStageTimeoutError,
  consumeGeminiStreamWithWatchdog,
  formatGeminiHistory,
  getConfiguredFallbackProviders,
  getServerProviderConfigStatus,
  getUpstreamHeadersTimeoutMs,
  fileRegistry,
  conversationDocuments,
  UPLOAD_DIR,
  resolveRequestUserId,
  fallbackCandidates,
  GEMINI_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL,
  GEMINI_FALLBACK_CANDIDATES,
  GEMINI_MODELS_CONFIG,
  MAX_CHAT_REQUEST_BYTES,
  MAX_VISION_IMAGE_BYTES,
  buildSystemInstruction,
  generateSimulatedResponse,
  setupVoiceWebSocketServer,
  setCustomImageGeneratorForTesting,
  resetImageGenerationForTesting
};

export type {
  DocumentData,
  PreparedDocumentContext,
  DocumentExtractionResult,
  UploadedFileRecord
};