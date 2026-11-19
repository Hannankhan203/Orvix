import React, { Component } from 'react';
import * as Sentry from '@sentry/react';

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

/**
 * @param {any} str
 * @returns {any}
 */
export function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const { pattern, replacement } of SENSITIVE_STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * @param {any} data
 * @param {number} [depth=0]
 * @returns {any}
 */
export function scrubSensitiveData(data, depth = 0) {
  if (depth > 6 || !data) return data;
  if (typeof data === 'string') return sanitizeString(data);
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((/** @type {any} */ item) => scrubSensitiveData(item, depth + 1));
  /** @type {Record<string, any>} */
  const result = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEY_REGEX.test(k)) {
      result[k] = '[Filtered]';
    } else {
      result[k] = scrubSensitiveData(v, depth + 1);
    }
  }
  return result;
}

let frontendSentryInitialized = false;

export function isFrontendSentryEnabled() {
  return frontendSentryInitialized;
}

export function initFrontendSentry() {
  const dsn = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_SENTRY_DSN : null;
  if (!dsn || typeof dsn !== 'string' || !dsn.trim()) {
    frontendSentryInitialized = false;
    return;
  }

  try {
    Sentry.init(/** @type {any} */ ({
      dsn: dsn.trim(),
      environment:
        (typeof import.meta !== 'undefined' && import.meta.env
          ? import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE
          : null) || 'production',
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      integrations: [
        Sentry.browserTracingIntegration()
      ],
      beforeSend(/** @type {any} */ event) {
        try {
          if (event.request) {
            if (event.request.headers) {
              const headers = { ...event.request.headers };
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
            if (event.request.data) {
              event.request.data = scrubSensitiveData(event.request.data);
            }
          }

          if (event.exception?.values) {
            for (const val of event.exception.values) {
              if (val.value) {
                val.value = sanitizeString(val.value);
              }
            }
          }

          if (event.message && typeof event.message === 'string') {
            event.message = sanitizeString(event.message);
          }

          if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map((/** @type {any} */ b) => ({
              ...b,
              message: b.message ? sanitizeString(b.message) : b.message,
              data: b.data ? scrubSensitiveData(b.data) : b.data
            }));
          }

          if (event.extra) {
            event.extra = scrubSensitiveData(event.extra);
          }
        } catch (_) {}
        return event;
      },
      beforeBreadcrumb(/** @type {any} */ breadcrumb) {
        if (breadcrumb.category === 'http' || breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
          if (breadcrumb.data?.url && typeof breadcrumb.data.url === 'string') {
            breadcrumb.data.url = sanitizeString(breadcrumb.data.url);
          }
          if (breadcrumb.data?.request_body) delete breadcrumb.data.request_body;
          if (breadcrumb.data?.response_body) delete breadcrumb.data.response_body;
        }
        if (breadcrumb.category === 'ui.click' || breadcrumb.category === 'ui.input') {
          if (breadcrumb.data?.value) delete breadcrumb.data.value;
        }
        if (breadcrumb.message) {
          breadcrumb.message = sanitizeString(breadcrumb.message);
        }
        return breadcrumb;
      }
    }));
    frontendSentryInitialized = true;
  } catch (err) {
    frontendSentryInitialized = false;
    console.warn('[Sentry] Failed to initialize frontend Sentry:', err);
  }
}

/**
 * @param {any} err
 * @param {any} [context]
 */
export function captureFrontendError(err, context) {
  if (!frontendSentryInitialized) return;
  try {
    Sentry.captureException(err, context ? { extra: scrubSensitiveData(context) } : undefined);
  } catch (_) {}
}

/**
 * @param {any} props
 */
export function SentryFallback({ error, resetError }) {
  return React.createElement(
    'div',
    { className: 'flex flex-col items-center justify-center min-h-[50vh] p-6 text-center text-slate-200' },
    React.createElement(
      'div',
      { className: 'w-12 h-12 mb-4 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center font-bold text-xl' },
      '!'
    ),
    React.createElement('h2', { className: 'text-xl font-semibold mb-2 text-white' }, 'Something went wrong'),
    React.createElement(
      'p',
      { className: 'text-sm text-slate-400 max-w-md mb-6' },
      error?.message || 'An unexpected application error occurred.'
    ),
    React.createElement(
      'div',
      { className: 'flex gap-3' },
      resetError
        ? React.createElement(
            'button',
            {
              onClick: resetError,
              className: 'px-4 py-2 text-sm font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors'
            },
            'Try Again'
          )
        : null,
      React.createElement(
        'button',
        {
          onClick: () => {
            if (typeof window !== 'undefined') window.location.reload();
          },
          className: 'px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors'
        },
        'Reload Page'
      )
    )
  );
}

/** @extends {Component<any, any>} */
export class SentryErrorBoundary extends Component {
  /** @param {any} props */
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  /** @param {any} error */
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  /**
   * @param {any} error
   * @param {any} errorInfo
   */
  componentDidCatch(error, errorInfo) {
    if (frontendSentryInitialized) {
      try {
        Sentry.captureException(error, { extra: scrubSensitiveData(errorInfo) });
      } catch (_) {}
    }
  }

  resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        if (typeof this.props.fallback === 'function') {
          return this.props.fallback({ error: this.state.error, resetError: this.resetError });
        }
        return this.props.fallback;
      }
      return React.createElement(SentryFallback, { error: this.state.error, resetError: this.resetError });
    }
    return this.props.children;
  }
}
