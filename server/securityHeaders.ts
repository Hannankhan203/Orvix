import type express from 'express';
import {
  applyTrustedProxySetting,
  resolveEffectiveRequestProtocol,
  type ForwardedRequestLike
} from './trustedProxy.ts';

/**
 * Exact SHA-256 hash of the inline theme initialization <script> in index.html.
 * Using an explicit hash avoids `'unsafe-inline'` in production `script-src`.
 */
export const INDEX_HTML_THEME_SCRIPT_SHA256 =
  "'sha256-YBAcKpsce3V/I66Kk5buhrn1xW5PZOLks5HZmzJBoVY='";

export const STRICT_TRANSPORT_SECURITY_VALUE = 'max-age=31536000; includeSubDomains';
export const X_CONTENT_TYPE_OPTIONS_VALUE = 'nosniff';
export const X_FRAME_OPTIONS_VALUE = 'DENY';
export const REFERRER_POLICY_VALUE = 'strict-origin-when-cross-origin';

/**
 * Restrictive browser Permissions-Policy tailored to Orvix's real feature set:
 * - Allows `microphone=(self)` for Voice Dictation (`getUserMedia({ audio: true })`).
 * - Denies unused hardware/sensor APIs (camera, geolocation, payment, usb, motion sensors, screen capture).
 */
export const PERMISSIONS_POLICY_VALUE =
  'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), display-capture=()';

const BASE_CONNECT_SRC_ORIGINS = [
  "'self'",
  'wss:',
  'blob:',
  'data:',
  // Firebase Auth & Cloud Firestore SDK endpoints
  'https://*.googleapis.com',
  'https://*.firebaseio.com',
  'wss://*.firebaseio.com',
  'https://*.firebaseapp.com',
  // Supabase Storage presigned uploads & signed attachment downloads
  'https://*.supabase.co',
  // WebLLM / WebGPU Browser AI model weights, CDN redirects, and compiled WASM libs
  'https://huggingface.co',
  'https://*.huggingface.co',
  'https://*.hf.co',
  'https://raw.githubusercontent.com',
  // Multilingual Tesseract OCR language packs
  'https://tessdata.projectnaptha.com',
  // Optional frontend Sentry telemetry ingestion
  'https://*.ingest.sentry.io',
  'https://*.ingest.us.sentry.io',
  'https://*.ingest.de.sentry.io'
] as const;

export interface BuildCspOptions {
  isDev?: boolean;
  isHttps?: boolean;
  extraConnectOrigins?: string[];
}

export interface SecurityHeadersOptions {
  isDev?: boolean;
  extraConnectOrigins?: string[];
}

function parseSafeHttpsOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\s;,'"`<>]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return null;
  }
}

function isAlreadyCoveredByBaseConnectSrc(origin: string): boolean {
  const lower = origin.toLowerCase();
  if (/^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(lower)) return true;
  if (/^https:\/\/[a-z0-9.-]+\.ingest(?:\.(?:us|de))?\.sentry\.io$/i.test(lower)) return true;
  if (/^https:\/\/[a-z0-9.-]+\.(?:googleapis\.com|firebaseio\.com|firebaseapp\.com|huggingface\.co|hf\.co)$/i.test(lower)) {
    return true;
  }
  return BASE_CONNECT_SRC_ORIGINS.some((entry) => entry.toLowerCase() === lower);
}

/**
 * Extracts validated custom HTTPS origins for self-hosted Supabase or Sentry endpoints
 * configured in server environment variables so CSP `connect-src` stays compatible.
 */
export function resolveConfiguredExtraConnectOrigins(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const candidates = [
    env.SUPABASE_URL,
    env.ORVIX_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.VITE_SUPABASE_URL,
    env.VITE_SENTRY_DSN
  ];

  const extra = new Set<string>();
  for (const raw of candidates) {
    const origin = parseSafeHttpsOrigin(raw);
    if (origin && !isAlreadyCoveredByBaseConnectSrc(origin)) {
      extra.add(origin);
    }
  }
  return Array.from(extra);
}

/**
 * Builds Orvix's Content-Security-Policy header tailored to its actual runtime dependencies:
 * - React + Tailwind + KaTeX (`style-src 'self' 'unsafe-inline'`, bundled local fonts)
 * - `index.html` theme bootstrap inline script pinned by SHA-256 hash (no `unsafe-inline` in prod `script-src`)
 * - WebAssembly compilation for WebLLM, oxipng, and gifsicle (`'wasm-unsafe-eval'`, never `'unsafe-eval'`)
 * - Web Workers, Service Worker, and AudioWorklet (`worker-src 'self' blob:`, `script-src ... blob:`)
 * - PDF blob preview iframe in DocumentPreviewModal (`frame-src 'self' blob:`)
 * - Clickjacking prevention (`frame-ancestors 'none'`)
 */
export function buildContentSecurityPolicy(options: BuildCspOptions = {}): string {
  const isDev = Boolean(options.isDev);
  const isHttps = Boolean(options.isHttps);

  const scriptSrc = [
    "'self'",
    INDEX_HTML_THEME_SCRIPT_SHA256,
    "'wasm-unsafe-eval'",
    'blob:'
  ];
  if (isDev) {
    // Vite dev server (@vitejs/plugin-react) injects an inline React Refresh preamble script in local dev only
    scriptSrc.push("'unsafe-inline'");
  }

  const connectSrc: string[] = [...BASE_CONNECT_SRC_ORIGINS];
  if (isDev) {
    // Allow local plain WebSocket for `/api/voice-stream` and Vite dev client on http://localhost
    connectSrc.push('ws:');
  }

  const dynamicOrigins = options.extraConnectOrigins ?? resolveConfiguredExtraConnectOrigins();
  for (const rawOrigin of dynamicOrigins) {
    const safeOrigin = parseSafeHttpsOrigin(rawOrigin);
    if (safeOrigin && !connectSrc.includes(safeOrigin)) {
      connectSrc.push(safeOrigin);
    }
  }

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'self' blob:",
    "manifest-src 'self'",
    `connect-src ${connectSrc.join(' ')}`
  ];

  if (isHttps) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

/**
 * Canonical production HTTPS CSP string matching `vercel.json`.
 */
export const PRODUCTION_CONTENT_SECURITY_POLICY = buildContentSecurityPolicy({
  isDev: false,
  isHttps: true,
  extraConnectOrigins: []
});

/**
 * Determines whether the incoming request arrived over HTTPS using trusted-proxy rules.
 * Ignores untrusted client-supplied `X-Forwarded-Proto: https` headers.
 */
export function isHttpsRequest(req?: ForwardedRequestLike | null): boolean {
  return resolveEffectiveRequestProtocol(req) === 'https';
}

function resolveDefaultDevMode(): boolean {
  const isServerlessRuntime = Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.SERVERLESS
  );
  const isTesting = process.env.TESTING === '1' || process.env.TESTING === 'true';
  return process.env.NODE_ENV !== 'production' && !isServerlessRuntime && !isTesting;
}

/**
 * Applies Orvix's full HTTP security header suite to an Express response.
 * HSTS (`Strict-Transport-Security`) is emitted strictly for verified HTTPS requests.
 */
export function applySecurityHeaders(
  req: express.Request,
  res: express.Response,
  options: SecurityHeadersOptions = {}
): void {
  const isHttps = isHttpsRequest(req);
  const isDev = options.isDev !== undefined ? options.isDev : resolveDefaultDevMode();
  const csp = buildContentSecurityPolicy({
    isDev,
    isHttps,
    extraConnectOrigins: options.extraConnectOrigins
  });

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', X_CONTENT_TYPE_OPTIONS_VALUE);
  res.setHeader('X-Frame-Options', X_FRAME_OPTIONS_VALUE);
  res.setHeader('Referrer-Policy', REFERRER_POLICY_VALUE);
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY_VALUE);

  if (isHttps) {
    res.setHeader('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY_VALUE);
  }
}

/**
 * Express middleware enforcing consistent HTTP security headers across all routes
 * (HTML documents, static assets, Service Worker, manifest, and API endpoints).
 */
export function applySecurityHeadersMiddleware(
  app: express.Express,
  options: SecurityHeadersOptions = {}
): void {
  app.disable('x-powered-by');
  applyTrustedProxySetting(app);

  app.use((req, res, next) => {
    applySecurityHeaders(req, res, options);
    next();
  });
}
