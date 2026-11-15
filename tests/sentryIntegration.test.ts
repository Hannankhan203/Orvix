import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import express from 'express';

import {
  initBackendSentry,
  isBackendSentryEnabled,
  captureBackendError,
  setupBackendExpressErrorHandler,
  scrubSensitiveData as scrubBackendData,
  sanitizeString as sanitizeBackendString
} from '../server/sentryService.ts';

import {
  initFrontendSentry,
  isFrontendSentryEnabled,
  captureFrontendError,
  SentryErrorBoundary,
  scrubSensitiveData as scrubFrontendData,
  sanitizeString as sanitizeFrontendString
} from '../src/services/sentryService.js';

test('Sentry Disabled Mode (Backend & Frontend)', () => {
  // Ensure DSN environment variables are unset/empty
  const origDsn = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;

  initBackendSentry();
  assert.equal(isBackendSentryEnabled(), false, 'Backend Sentry should be disabled when DSN is empty');

  // Should no-op safely without throwing
  assert.doesNotThrow(() => {
    captureBackendError(new Error('Test disabled error'));
  });

  // Frontend initialization check
  initFrontendSentry();
  assert.equal(isFrontendSentryEnabled(), false, 'Frontend Sentry should be disabled when VITE_SENTRY_DSN is empty');

  assert.doesNotThrow(() => {
    captureFrontendError(new Error('Test frontend disabled error'), { extraInfo: 'safe' });
  });

  // Restore env
  if (origDsn) process.env.SENTRY_DSN = origDsn;
});

test('Backend Express Error Handler Attachment', () => {
  const app = express();
  assert.doesNotThrow(() => {
    setupBackendExpressErrorHandler(app);
  }, 'setupBackendExpressErrorHandler should not throw even if Sentry is uninitialized');
});

test('Sensitive String Scrubbing (API keys, Tokens, Emails, Base64)', () => {
  const googleKey = 'AIzaSyC1234567890abcdef1234567890abcd';
  const groqKey = 'gsk_1234567890abcdef1234567890abcdef12345678';
  const openRouterKey = 'sk-or-v1-1234567890abcdef1234567890abcdef';
  const bearerToken = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.xyz123';
  const email = 'developer@orvix.ai';
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  const rawMessage = `Error with ${googleKey}, ${groqKey}, ${openRouterKey}, ${bearerToken}, ${email}, and ${dataUrl}`;

  const sanitized = sanitizeBackendString(rawMessage) as string;

  assert.doesNotMatch(sanitized, /AIzaSy/, 'Google API key must be sanitized');
  assert.doesNotMatch(sanitized, /gsk_/, 'Groq API key must be sanitized');
  assert.doesNotMatch(sanitized, /sk-or-v1/, 'OpenRouter key must be sanitized');
  assert.doesNotMatch(sanitized, /Bearer eyJ/, 'Bearer token must be sanitized');
  assert.doesNotMatch(sanitized, /developer@orvix\.ai/, 'Email address must be sanitized');
  assert.doesNotMatch(sanitized, /iVBORw0KGgoAAA/, 'Base64 image content must be sanitized');

  assert.match(sanitized, /\[FILTERED_KEY\]/);
  assert.match(sanitized, /Bearer \[FILTERED\]/);
  assert.match(sanitized, /\[FILTERED_EMAIL\]/);
  assert.match(sanitized, /data:\[FILTERED_BASE64\]/);
});

test('Deep Object & Array Sensitive Data Scrubbing', () => {
  const payload = {
    payloadName: 'standard_payload',
    apiKey: 'AIzaSyC1234567890abcdef1234567890abcd',
    password: 'SuperSecretPassword123!',
    token: 'jwt.token.here',
    secret: 'session_secret',
    messages: [
      { role: 'user', content: 'Private chat message content' },
      { role: 'assistant', content: 'Assistant response' }
    ],
    documents: [
      { name: 'resume.pdf', extractedText: 'Private confidential text' }
    ],
    nested: {
      authHeader: 'Bearer 12345',
      userEmail: 'alice@example.com',
      metadata: {
        publicFlag: true,
        secretCode: 9999
      }
    }
  };

  const scrubbed = scrubBackendData(payload) as any;

  assert.equal(scrubbed.payloadName, 'standard_payload');
  assert.equal(scrubbed.apiKey, '[Filtered]');
  assert.equal(scrubbed.password, '[Filtered]');
  assert.equal(scrubbed.token, '[Filtered]');
  assert.equal(scrubbed.secret, '[Filtered]');
  assert.equal(scrubbed.messages, '[Filtered]');
  assert.equal(scrubbed.documents, '[Filtered]');
  assert.equal(scrubbed.nested.authHeader, '[Filtered]');
  assert.equal(scrubbed.nested.userEmail, '[Filtered]');
  assert.equal(scrubbed.nested.metadata.publicFlag, true);
  assert.equal(scrubbed.nested.metadata.secretCode, '[Filtered]');
});

test('Frontend SentryErrorBoundary Component Rendering', () => {
  // Test normal rendering without error
  const normalElement = React.createElement(
    SentryErrorBoundary,
    null,
    React.createElement('div', { id: 'test-child' }, 'Normal Child Content')
  );

  const normalHtml = ReactDOMServer.renderToString(normalElement);
  assert.match(normalHtml, /Normal Child Content/, 'ErrorBoundary should render children normally');

  // Test fallback rendering when component catches an error
  class TestBrokenComponent extends React.Component {
    render(): React.ReactNode {
      throw new Error('Component crashed during test');
    }
  }

  // In SSR renderToString, class components throw directly, so we verify getDerivedStateFromError
  const errorState = SentryErrorBoundary.getDerivedStateFromError(new Error('Fatal UI error'));
  assert.equal(errorState.hasError, true);
  assert.equal(errorState.error.message, 'Fatal UI error');

  // Verify custom fallback rendering with error state
  const boundaryInstance: any = new SentryErrorBoundary({
    fallback: ({ error }: { error: Error }) => React.createElement('div', null, `Handled: ${error.message}`)
  });
  boundaryInstance.state = { hasError: true, error: new Error('Handled UI crash') };
  const renderedFallback = boundaryInstance.render();
  const fallbackHtml = ReactDOMServer.renderToString(renderedFallback as React.ReactElement);
  assert.match(fallbackHtml, /Handled: Handled UI crash/);
});
