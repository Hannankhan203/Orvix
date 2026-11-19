import test from 'node:test';
import assert from 'node:assert/strict';

import { isQuietTestLogsEnabled } from '../server/diagnosticLogger.ts';
import {
  InMemoryRedisMock,
  redis,
  getConfiguredRedisUrl,
  getRedisClient,
  resetRedisClientForTesting
} from '../server/redisClient.ts';
import {
  consumeRateLimit,
  InMemoryRateLimitStore,
  resetRateLimitersForTesting
} from '../server/rateLimiter.ts';
// @ts-ignore - JS client modules
import { logWebLLMStage, getWebLLMDiagnostics } from '../src/services/webllmService.js';
// @ts-ignore - JS client modules
import {
  createDiagnosticSession,
  finalizeDiagnosticSession,
  getLastDictationDiagnostic,
  isQuietTestLogsEnabled as isClientQuietTestLogsEnabled,
  setDictationDiagnosticsEnabled
} from '../src/utils/dictationDiagnostics.js';

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  const restore = () => {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function captureConsole() {
  const logs: unknown[][] = [];
  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  const origGroupCollapsed = console.groupCollapsed;
  const origGroupEnd = console.groupEnd;

  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  console.info = (...args: unknown[]) => {
    infos.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  console.groupCollapsed = (...args: unknown[]) => {
    logs.push(args);
  };
  console.groupEnd = () => {};

  return {
    logs,
    infos,
    warns,
    errors,
    restore() {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
      console.groupCollapsed = origGroupCollapsed;
      console.groupEnd = origGroupEnd;
    }
  };
}

test('AUD-NON-01: isQuietTestLogsEnabled activates only with ORVIX_QUIET_TEST_LOGS=true and preserves real production diagnostics', () => {
  withEnv({ ORVIX_QUIET_TEST_LOGS: undefined }, () => {
    assert.equal(isQuietTestLogsEnabled(), false);
    assert.equal(isClientQuietTestLogsEnabled(), false);
  });

  withEnv({ ORVIX_QUIET_TEST_LOGS: 'false' }, () => {
    assert.equal(isQuietTestLogsEnabled(), false);
    assert.equal(isClientQuietTestLogsEnabled(), false);
  });

  withEnv({ ORVIX_QUIET_TEST_LOGS: 'true' }, () => {
    assert.equal(isQuietTestLogsEnabled(), true);
    assert.equal(isClientQuietTestLogsEnabled(), true);
  });

  // Production outside any automated test runner must NEVER suppress diagnostics
  withEnv(
    {
      ORVIX_QUIET_TEST_LOGS: 'true',
      NODE_ENV: 'production',
      NODE_TEST_CONTEXT: undefined,
      TESTING: undefined,
      VITEST: undefined,
      JEST_WORKER_ID: undefined,
      PLAYWRIGHT_TEST: undefined
    },
    () => {
      assert.equal(isQuietTestLogsEnabled(), false);
      assert.equal(isClientQuietTestLogsEnabled(), false);
    }
  );
});

test('AUD-NON-01: WebLLM suppresses verbose log/warn diagnostics when ORVIX_QUIET_TEST_LOGS=true while keeping errors and diagnostic buffer intact', () => {
  const cap = captureConsole();
  try {
    withEnv({ ORVIX_QUIET_TEST_LOGS: 'true' }, () => {
      logWebLLMStage('quiet_test_info', { step: 'a' }, { level: 'log' });
      logWebLLMStage('quiet_test_warn', { step: 'b' }, { level: 'warn' });
      logWebLLMStage('quiet_test_error', { step: 'c' }, { level: 'error' });
    });

    assert.equal(cap.logs.length, 0, 'Verbose WebLLM console.log should be suppressed in quiet mode');
    assert.equal(cap.warns.length, 0, 'Verbose WebLLM console.warn should be suppressed in quiet mode');
    assert.equal(cap.errors.length, 1, 'Meaningful WebLLM console.error must NOT be suppressed');

    const events = getWebLLMDiagnostics();
    assert.ok(events.some((e: any) => e.stage === 'quiet_test_info'));
    assert.ok(events.some((e: any) => e.stage === 'quiet_test_warn'));
    assert.ok(events.some((e: any) => e.stage === 'quiet_test_error'));

    // Normal diagnostics resume when ORVIX_QUIET_TEST_LOGS is not true
    withEnv({ ORVIX_QUIET_TEST_LOGS: undefined }, () => {
      logWebLLMStage('normal_test_info', { step: 'd' }, { level: 'log' });
      logWebLLMStage('normal_test_warn', { step: 'e' }, { level: 'warn' });
    });
    assert.equal(cap.logs.length, 1);
    assert.equal(cap.warns.length, 1);
  } finally {
    cap.restore();
  }
});

test('AUD-NON-01: RateLimiter and Redis suppress verbose fallback warnings under ORVIX_QUIET_TEST_LOGS=true and emit normally otherwise', async () => {
  const cap = captureConsole();
  const mem = new InMemoryRateLimitStore(false);
  const notReadyRedis = {
    status: 'reconnecting',
    eval: async () => {
      throw new Error('not ready');
    }
  };

  try {
    resetRateLimitersForTesting();
    await resetRedisClientForTesting();

    // Quiet mode: RateLimiter + Redis verbose diagnostics suppressed
    await withEnv(
      {
        ORVIX_QUIET_TEST_LOGS: 'true',
        REDIS_URL: 'http://invalid-scheme.local'
      },
      async () => {
        assert.equal(getConfiguredRedisUrl(), '');

        process.env.REDIS_URL = 'not-a-valid-url';
        assert.equal(getConfiguredRedisUrl(), '');

        process.env.REDIS_URL = 'redis://in-memory-mock';
        const client = getRedisClient();
        assert.ok(client);
        await client!.connect?.();

        const decision = await consumeRateLimit(
          {
            policy: 'chat',
            max: 5,
            windowMs: 10_000,
            redisClient: notReadyRedis,
            memoryStore: mem,
            failureMode: 'memory'
          },
          { type: 'ip', hashedId: 'quiet-test-ip' }
        );
        assert.equal(decision.allowed, true);
        assert.equal(decision.backend, 'memory');
      }
    );

    assert.equal(cap.logs.length, 0, 'Redis verbose console.log should be suppressed in quiet mode');
    assert.equal(cap.warns.length, 0, 'Redis and RateLimiter verbose console.warn should be suppressed in quiet mode');

    // Normal mode: diagnostics emit as expected
    resetRateLimitersForTesting();
    await resetRedisClientForTesting();
    await withEnv(
      {
        ORVIX_QUIET_TEST_LOGS: undefined,
        REDIS_URL: 'http://invalid-scheme.local'
      },
      async () => {
        assert.equal(getConfiguredRedisUrl(), '');
        await consumeRateLimit(
          {
            policy: 'chat',
            max: 5,
            windowMs: 10_000,
            redisClient: notReadyRedis,
            memoryStore: mem,
            failureMode: 'memory'
          },
          { type: 'ip', hashedId: 'normal-test-ip' }
        );
      }
    );

    assert.ok(
      cap.warns.some((args) => String(args[0]).includes('[Redis]')),
      'Redis warning should emit normally when ORVIX_QUIET_TEST_LOGS is unset'
    );
    assert.ok(
      cap.warns.some((args) => String(args[0]).includes('[RateLimiter]')),
      'RateLimiter warning should emit normally when ORVIX_QUIET_TEST_LOGS is unset'
    );
  } finally {
    cap.restore();
    mem.clear();
    resetRateLimitersForTesting();
    await resetRedisClientForTesting();
  }
});

test('AUD-NON-01: Dictation diagnostics suppress verbose console output under ORVIX_QUIET_TEST_LOGS=true while retaining report state', () => {
  const prevWindow = (globalThis as any).window;
  const prevStorage = (globalThis as any).localStorage;
  const store = new Map<string, string>();
  (globalThis as any).window = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k)
  };

  const cap = captureConsole();
  try {
    withEnv({ ORVIX_QUIET_TEST_LOGS: 'true' }, () => {
      setDictationDiagnosticsEnabled(true);
      const session = createDiagnosticSession({
        sessionId: 'quiet-dict-1',
        engineMode: 'browser-speech',
        language: 'en-US'
      });
      session.finalComposerTranscript = 'hello world';
      const report = finalizeDiagnosticSession(session);
      assert.ok(report, 'Diagnostic report must still be returned in quiet mode');
      assert.equal(report.sessionId, 'quiet-dict-1');
      assert.equal(getLastDictationDiagnostic()?.sessionId, 'quiet-dict-1');
    });

    assert.equal(cap.infos.length, 0, 'Dictation info banner should be suppressed in quiet mode');
    assert.equal(cap.logs.length, 0, 'Dictation verbose console report should be suppressed in quiet mode');

    // Normal mode emits diagnostic console output
    withEnv({ ORVIX_QUIET_TEST_LOGS: undefined }, () => {
      const session = createDiagnosticSession({
        sessionId: 'normal-dict-2',
        engineMode: 'browser-speech',
        language: 'en-US'
      });
      const report = finalizeDiagnosticSession(session);
      assert.ok(report);
    });

    assert.ok(cap.logs.length > 0, 'Dictation console report should emit normally when ORVIX_QUIET_TEST_LOGS is unset');
  } finally {
    cap.restore();
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
    if (prevStorage === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = prevStorage;
  }
});

test('AUD-NON-02: Legacy exported redis helper preserves API compatibility and is fully isolated from InMemoryRedisMock instances', async () => {
  await resetRedisClientForTesting();

  // 1. Legacy helper API compatibility (get, set, del, incr)
  assert.equal(await redis.get('aud-non-02:missing'), null);
  assert.equal(await redis.set('aud-non-02:key', 'hello'), 'OK');
  assert.equal(await redis.get('aud-non-02:key'), 'hello');
  assert.equal(await redis.incr('aud-non-02:counter'), 1);
  assert.equal(await redis.incr('aud-non-02:counter'), 2);
  assert.equal(await redis.del('aud-non-02:key'), true);
  assert.equal(await redis.del('aud-non-02:key'), false);
  assert.equal(await redis.get('aud-non-02:key'), null);

  // 2. Isolation between legacy `redis` helper and separate `InMemoryRedisMock` instances
  const mockA = new InMemoryRedisMock();
  const mockB = new InMemoryRedisMock();
  await mockA.connect();
  await mockB.connect();

  await redis.set('shared-name', 'from-legacy');
  await mockA.set('shared-name', 'from-mockA');

  assert.equal(await redis.get('shared-name'), 'from-legacy');
  assert.equal(await mockA.get('shared-name'), 'from-mockA');
  assert.equal(await mockB.get('shared-name'), null);

  // Rate-limit Lua eval on mockA does not leak into legacy `redis` helper or mockB
  const evalA = (await mockA.eval('INCR', 1, 'aud-non-02:counter', 60_000)) as [number, number];
  assert.equal(evalA[0], 1, 'mockA counter must start at 1 independent of legacy redis helper');
  assert.equal(await redis.get('aud-non-02:counter'), 2, 'legacy redis counter must remain untouched by mockA');
  assert.equal(await mockB.get('aud-non-02:counter'), null, 'mockB must remain isolated from mockA and legacy redis');

  // 3. Calling clearAllForTesting() on an InMemoryRedisMock must NOT wipe the legacy helper or other mocks
  await mockB.set('mockB-key', 'intact');
  mockA.clearAllForTesting();
  assert.equal(await mockA.get('shared-name'), null);
  assert.equal(await redis.get('shared-name'), 'from-legacy', 'mockA.clearAllForTesting must not clear legacy redis helper');
  assert.equal(await mockB.get('mockB-key'), 'intact', 'mockA.clearAllForTesting must not clear mockB');

  // 4. resetRedisClientForTesting() resets the legacy helper without touching independent mock instances
  await resetRedisClientForTesting();
  assert.equal(await redis.get('shared-name'), null);
  assert.equal(await mockB.get('mockB-key'), 'intact');
});
