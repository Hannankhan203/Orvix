import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent, EventHint, NodeOptions } from '@sentry/node';
import type express from 'express';

type StreamedSpan = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

export const SENSITIVE_KEY_REGEX =
  /(key|token|secret|password|auth|cookie|prompt|message|content|attachment|document|file|buffer|base64|extract|email|phone|credential)/i;

export const SENSITIVE_STRING_PATTERNS = [
  { pattern: /AIza[0-9A-Za-z_-]{30,40}/g, replacement: '[FILTERED_KEY]' },
  { pattern: /gsk_[0-9A-Za-z]{30,}/g, replacement: '[FILTERED_KEY]' },
  { pattern: /sk-[0-9A-Za-z_-]{20,}/g, replacement: '[FILTERED_KEY]' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: 'Bearer [FILTERED]' },
  { pattern: /data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, replacement: 'data:[FILTERED_BASE64]' },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[FILTERED_JWT]' },
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[FILTERED_EMAIL]' }
];

export function sanitizeString(str: unknown): unknown {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const { pattern, replacement } of SENSITIVE_STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function scrubSensitiveData(data: unknown, depth = 0): unknown {
  if (depth > 6 || !data) return data;
  if (typeof data === 'string') return sanitizeString(data);
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((item) => scrubSensitiveData(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(k)) {
      result[k] = '[Filtered]';
    } else {
      result[k] = scrubSensitiveData(v, depth + 1);
    }
  }
  return result;
}

let backendSentryInitialized = false;

export function isBackendSentryEnabled(): boolean {
  return backendSentryInitialized;
}

export function initBackendSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || typeof dsn !== 'string' || !dsn.trim()) {
    backendSentryInitialized = false;
    return;
  }

  try {
    Sentry.init({
      dsn: dsn.trim(),
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
      beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
        try {
          if (event.request) {
            if (event.request.headers) {
              const headers: Record<string, string> = { ...event.request.headers };
              for (const headerKey of Object.keys(headers)) {
                if (
                  headerKey.toLowerCase().includes('auth') ||
                  headerKey.toLowerCase().includes('cookie') ||
                  headerKey.toLowerCase().includes('key')
                ) {
                  delete headers[headerKey];
                }
              }
              event.request.headers = headers;
            }
            if (event.request.cookies) {
              event.request.cookies = {};
            }
            if (event.request.query_string && typeof event.request.query_string === 'string') {
              event.request.query_string = sanitizeString(event.request.query_string) as string;
            }
            if (event.request.data) {
              event.request.data = scrubSensitiveData(event.request.data);
            }
          }

          if (event.exception?.values) {
            for (const val of event.exception.values) {
              if (val.value) {
                val.value = sanitizeString(val.value) as string;
              }
            }
          }

          if (event.message && typeof event.message === 'string') {
            event.message = sanitizeString(event.message) as string;
          }

          if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map((b: Breadcrumb) => ({
              ...b,
              message: b.message ? (sanitizeString(b.message) as string) : b.message,
              data: b.data ? (scrubSensitiveData(b.data) as Record<string, unknown>) : b.data
            }));
          }

          if (event.extra) {
            event.extra = scrubSensitiveData(event.extra) as Record<string, unknown>;
          }
        } catch (_) {}
        return event;
      },
      beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
        if (breadcrumb.category === 'http' || breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
          if (breadcrumb.data?.url && typeof breadcrumb.data.url === 'string') {
            breadcrumb.data.url = sanitizeString(breadcrumb.data.url) as string;
          }
          if (breadcrumb.data?.request_body) delete breadcrumb.data.request_body;
          if (breadcrumb.data?.response_body) delete breadcrumb.data.response_body;
        }
        if (breadcrumb.message) {
          breadcrumb.message = sanitizeString(breadcrumb.message) as string;
        }
        return breadcrumb;
      },
      beforeSendSpan(span: StreamedSpan): StreamedSpan {
        if (span.attributes) {
          for (const key of Object.keys(span.attributes)) {
            if (SENSITIVE_KEY_REGEX.test(key)) {
              span.attributes[key] = '[Filtered]';
            } else if (typeof span.attributes[key] === 'string') {
              span.attributes[key] = sanitizeString(span.attributes[key]);
            }
          }
        }
        return span;
      }
    });
    backendSentryInitialized = true;
  } catch (err) {
    backendSentryInitialized = false;
    console.warn('[Sentry] Failed to initialize backend Sentry:', err);
  }
}

export function setupBackendExpressErrorHandler(app: express.Express) {
  if (!backendSentryInitialized) return;
  try {
    Sentry.setupExpressErrorHandler(app);
  } catch (err) {
    console.warn('[Sentry] Failed to attach Express error handler:', err);
  }
}

export function captureBackendError(err: unknown, context?: Record<string, unknown>) {
  if (!backendSentryInitialized) return;
  try {
    Sentry.captureException(err, context ? { extra: scrubSensitiveData(context) as Record<string, unknown> } : undefined);
  } catch (_) {}
}
