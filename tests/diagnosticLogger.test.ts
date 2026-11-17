import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveLogLevel,
  shouldLog,
  sanitizeErrorLog,
  logUploadDiagnostic,
  logAIDiagnostic,
  logGeminiLifecycleEvent
} from '../server/diagnosticLogger.ts';

test('INFO-OPT-02: LOG_LEVEL configuration and shouldLog filtering', () => {
  const prevLogLevel = process.env.LOG_LEVEL;
  const prevDebug = process.env.DEBUG;

  try {
    // 1. Default (missing) LOG_LEVEL falls back to 'info'
    delete process.env.LOG_LEVEL;
    delete process.env.DEBUG;
    assert.equal(getActiveLogLevel(), 'info');
    assert.equal(shouldLog('info'), true);
    assert.equal(shouldLog('warn'), true);
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('debug'), false);

    // 2. Explicit 'error' level
    process.env.LOG_LEVEL = 'error';
    assert.equal(getActiveLogLevel(), 'error');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('warn'), false);
    assert.equal(shouldLog('info'), false);
    assert.equal(shouldLog('debug'), false);

    // 3. Explicit 'warn' level
    process.env.LOG_LEVEL = 'warn';
    assert.equal(getActiveLogLevel(), 'warn');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('warn'), true);
    assert.equal(shouldLog('info'), false);
    assert.equal(shouldLog('debug'), false);

    // 4. Explicit 'debug' level (case-insensitive)
    process.env.LOG_LEVEL = 'DEBUG';
    assert.equal(getActiveLogLevel(), 'debug');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('warn'), true);
    assert.equal(shouldLog('info'), true);
    assert.equal(shouldLog('debug'), true);

    // 5. Invalid LOG_LEVEL falls back safely to 'info'
    process.env.LOG_LEVEL = 'invalid_verbose_level';
    assert.equal(getActiveLogLevel(), 'info');
  } finally {
    if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLogLevel;
    if (prevDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = prevDebug;
  }
});

test('INFO-OPT-02: sanitizeErrorLog redacts sensitive secrets, keys, and tokens', () => {
  const rawMessage = 'Error connecting with Bearer secretToken12345, JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfS.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c, API key AIzaSyA1234567890abcdefghijklmnopqrstuvwx, and GEMINI_API_KEY=secret_gemini_key_abc.';
  const sanitized = sanitizeErrorLog(rawMessage);

  assert.ok(!sanitized.includes('secretToken12345'));
  assert.ok(!sanitized.includes('secret_gemini_key_abc'));
  assert.ok(sanitized.includes('Bearer [REDACTED]'));
  assert.ok(sanitized.includes('[REDACTED_API_KEY]'));
  assert.ok(sanitized.includes('GEMINI_API_KEY=[REDACTED]'));
});

test('INFO-OPT-02: Diagnostic log functions execute safely under filtered log levels', () => {
  process.env.LOG_LEVEL = 'error';
  try {
    // Should be suppressed or run safely without throwing
    logUploadDiagnostic({
      stage: 'firebase_auth',
      message: 'Test auth error with key AIzaSyA1234567890abcdefghijklmnopqrstuvwx'
    });

    logAIDiagnostic({
      category: 'request validation error' as any,
      provider: 'gemini',
      sanitizedMessage: 'Test AI warning'
    });

    const entry = logGeminiLifecycleEvent({
      event: 'request_start',
      elapsedMs: 10,
      httpStatus: 200,
      model: 'gemini-2.5-flash',
      chunkCount: 0,
      streamState: 'idle'
    });
    assert.equal(entry.model, 'gemini-2.5-flash');
  } finally {
    delete process.env.LOG_LEVEL;
  }
});
