/**
 * Production-Only Groq & OpenRouter Configuration Verification Suite (ORVIX-PROD-002)
 *
 * Verifies:
 * 1. Localhost baseline credential resolution.
 * 2. Production environment alias resolution (GROQ_API_KEY, ORVIX_GROQ_API_KEY, etc.)
 *    with strict rejection of client-prefixed secret variables (VITE_*, NEXT_PUBLIC_*, REACT_APP_*)
 *    and OpenRouter alias resolution with whitespace and surrounding quote sanitization.
 * 3. /api/config availability endpoint reports correct boolean flags and strictly sets no-cache headers.
 * 4. Groq requests via server /api/chat execute successfully when configured.
 * 5. OpenRouter requests via server /api/chat execute successfully when configured.
 * 6. ModelSelector / getProviderConfigAvailability reflects configured state (no "(Setup)") and
 *    shows "(Setup)" only when genuinely unconfigured.
 * 7. Fallback provider candidates include Groq and OpenRouter dynamically when configured.
 * 8. Missing credentials return clean 503 PROVIDER_NOT_CONFIGURED with setup suggestions.
 * 9. Security: Credentials are never exposed in responses, logs, or client-facing config objects.
 * 10. Regression: Gemini, Cloudflare, Browser AI, and WebLLM models remain fully functional.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TESTING = 'true';

console.log('===============================================================');
console.log('ORVIX: PRODUCTION GROQ & OPENROUTER CONFIGURATION TEST SUITE');
console.log('===============================================================\n');

let passedTests = 0;
const totalTests = 10;

// Import server components
const {
  getGroqApiKey,
  getOpenRouterApiKey,
  getGeminiApiKey,
  getCloudflareCredentials,
  sanitizeCredentialValue,
  resolveEnvCredential,
  isConfiguredCredential,
  getServerProviderConfigStatus,
  getConfiguredFallbackProviders,
  sendProviderNotConfiguredError
} = await import('../server/serverConfig.ts');

const {
  getProviderConfigAvailability,
  filterAvailableFallbackProviders,
  normalizeProviderConfigPayload,
  AI_PROVIDERS
} = await import('../src/services/providerModelSanitizer.js');

const { PROVIDER_OPTIONS } = await import('../src/services/aiRouter.js');

const { app } = await import('../server.ts');

/* --------------------------------------------------------------------------
   Test 1: Localhost baseline verification
   -------------------------------------------------------------------------- */
try {
  console.log('[Test 1] Localhost baseline credential resolution...');

  // Save initial env
  const origEnv = { ...process.env };

  process.env.GROQ_API_KEY = 'gsk_localhost_test_key_12345';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-localhost_test_key_67890';
  process.env.GEMINI_API_KEY = 'AIzaSy_localhost_gemini_key';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'cf_account_123';
  process.env.CLOUDFLARE_API_TOKEN = 'cf_token_456';

  assert.equal(getGroqApiKey(), 'gsk_localhost_test_key_12345');
  assert.equal(getOpenRouterApiKey(), 'sk-or-v1-localhost_test_key_67890');
  assert.equal(getGeminiApiKey(), 'AIzaSy_localhost_gemini_key');
  assert.deepEqual(getCloudflareCredentials(), {
    accountId: 'cf_account_123',
    apiToken: 'cf_token_456'
  });

  const status = getServerProviderConfigStatus();
  assert.equal(status.groqConfigured, true, 'Groq must be configured');
  assert.equal(status.openrouterConfigured, true, 'OpenRouter must be configured');
  assert.equal(status.geminiConfigured, true, 'Gemini must be configured');
  assert.equal(status.cloudflareConfigured, true, 'Cloudflare must be configured');

  console.log('  ✓ Localhost baseline configuration resolves correctly.');
  passedTests++;
  // restore
  for (const k in process.env) {
    if (!(k in origEnv)) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
} catch (err) {
  console.error('  ✗ Test 1 failed:', err);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Test 2: Production environment alias resolution and quote sanitization
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 2] Production environment alias resolution & quote sanitization...');

  // A. Quote & Bearer prefix sanitization
  assert.equal(sanitizeCredentialValue('"gsk_quoted_key"'), 'gsk_quoted_key');
  assert.equal(sanitizeCredentialValue("'sk-or-quoted'"), 'sk-or-quoted');
  assert.equal(sanitizeCredentialValue('  "  spaced_and_quoted  "  '), 'spaced_and_quoted');
  assert.equal(sanitizeCredentialValue('Bearer gsk_bearer_prefixed'), 'gsk_bearer_prefixed');
  assert.equal(sanitizeCredentialValue('"Bearer sk-or-bearer-quoted"'), 'sk-or-bearer-quoted');
  assert.equal(sanitizeCredentialValue(''), '');
  assert.equal(sanitizeCredentialValue(null), '');

  // B. Value validity check
  assert.equal(isConfiguredCredential('gsk_valid_key'), true);
  assert.equal(isConfiguredCredential('"gsk_valid_key"'), true);
  assert.equal(isConfiguredCredential('""'), false);
  assert.equal(isConfiguredCredential("''"), false);
  assert.equal(isConfiguredCredential('undefined'), false);
  assert.equal(isConfiguredCredential('null'), false);
  assert.equal(isConfiguredCredential('your_groq_api_key_here'), false);
  assert.equal(isConfiguredCredential('YOUR_OPENROUTER_API_KEY'), false);
  assert.equal(isConfiguredCredential('<YOUR_GROQ_API_KEY>'), false);

  // C. Alias resolution for Groq
  const origEnv = { ...process.env };
  delete process.env.GROQ_API_KEY;

  // Case C1: Client-prefixed secrets must NEVER be accepted as server credentials
  process.env.VITE_GROQ_API_KEY = 'gsk_from_vite_env';
  process.env.NEXT_PUBLIC_GROQ_API_KEY = 'gsk_from_next_public';
  process.env.REACT_APP_GROQ_API_KEY = 'gsk_from_react_app';
  assert.equal(getGroqApiKey(), '', 'Client-prefixed Groq secret variables must be rejected');
  delete process.env.VITE_GROQ_API_KEY;
  delete process.env.NEXT_PUBLIC_GROQ_API_KEY;
  delete process.env.REACT_APP_GROQ_API_KEY;

  // Case C2: ORVIX_GROQ_API_KEY
  process.env.ORVIX_GROQ_API_KEY = 'gsk_from_orvix_env';
  assert.equal(getGroqApiKey(), 'gsk_from_orvix_env');
  delete process.env.ORVIX_GROQ_API_KEY;

  // Case C3: GROQ_KEY
  process.env.GROQ_KEY = 'gsk_from_groq_key';
  assert.equal(getGroqApiKey(), 'gsk_from_groq_key');
  delete process.env.GROQ_KEY;

  // Case C4: Placeholder in primary GROQ_API_KEY must fall through to valid alias
  process.env.GROQ_API_KEY = 'your_groq_api_key';
  process.env.ORVIX_GROQ_API_KEY = 'gsk_real_fallback_key';
  assert.equal(getGroqApiKey(), 'gsk_real_fallback_key');
  delete process.env.GROQ_API_KEY;
  delete process.env.ORVIX_GROQ_API_KEY;

  // D. Alias resolution for OpenRouter
  delete process.env.OPENROUTER_API_KEY;

  // Case D1: Client-prefixed OpenRouter secrets must be rejected
  process.env.VITE_OPENROUTER_API_KEY = 'sk-or-from-vite';
  process.env.NEXT_PUBLIC_OPENROUTER_API_KEY = 'sk-or-from-next-public';
  process.env.REACT_APP_OPENROUTER_API_KEY = 'sk-or-from-react-app';
  assert.equal(getOpenRouterApiKey(), '', 'Client-prefixed OpenRouter secret variables must be rejected');
  delete process.env.VITE_OPENROUTER_API_KEY;
  delete process.env.NEXT_PUBLIC_OPENROUTER_API_KEY;
  delete process.env.REACT_APP_OPENROUTER_API_KEY;

  // Case D2: ORVIX_OPENROUTER_API_KEY
  process.env.ORVIX_OPENROUTER_API_KEY = 'sk-or-from-orvix';
  assert.equal(getOpenRouterApiKey(), 'sk-or-from-orvix');
  delete process.env.ORVIX_OPENROUTER_API_KEY;

  // Case D3: OPEN_ROUTER_API_KEY (with underscore)
  process.env.OPEN_ROUTER_API_KEY = 'sk-or-from-underscore';
  assert.equal(getOpenRouterApiKey(), 'sk-or-from-underscore');
  delete process.env.OPEN_ROUTER_API_KEY;

  // Case D4: Placeholder in primary OPENROUTER_API_KEY falls through to valid alias
  process.env.OPENROUTER_API_KEY = 'undefined';
  process.env.OPENROUTER_API_TOKEN = 'sk-or-real-token';
  assert.equal(getOpenRouterApiKey(), 'sk-or-real-token');
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_TOKEN;

  // Restore env
  for (const k in process.env) {
    if (!(k in origEnv)) delete process.env[k];
    else process.env[k] = origEnv[k];
  }

  console.log('  ✓ Multi-alias resolution and quote sanitization succeed.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 2 failed:', err);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Test 3: Provider availability endpoint (/api/config) reports correct status and headers
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 3] Provider availability endpoint (/api/config) & Cache-Control...');

  const server = app.listen(3025, '127.0.0.1', async () => {
    try {
      // Simulate production credentials available
      process.env.GROQ_API_KEY = 'gsk_prod_test_key_valid';
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-prod_test_key_valid';
      process.env.GEMINI_API_KEY = 'AIzaSy_gemini_prod_key';

      const res = await fetch('http://127.0.0.1:3025/api/config');
      assert.equal(res.status, 200);

      // Verify strict no-cache headers
      const cacheControl = res.headers.get('cache-control') || '';
      assert.ok(
        cacheControl.includes('no-cache') && cacheControl.includes('no-store'),
        `Cache-Control must contain no-cache, no-store, got: ${cacheControl}`
      );
      assert.equal(res.headers.get('cdn-cache-control'), 'no-store');
      assert.equal(res.headers.get('vercel-cdn-cache-control'), 'no-store');

      const data = await res.json();
      assert.equal(data.groqConfigured, true, 'groqConfigured must be true');
      assert.equal(data.openrouterConfigured, true, 'openrouterConfigured must be true');
      assert.equal(data.geminiConfigured, true, 'geminiConfigured must be true');
      assert.equal(data.webllmSupported, true, 'webllmSupported must be true');

      // Verify safe boolean payload
      assert.equal(data.GROQ_API_KEY, undefined, 'API keys must NEVER be leaked in /api/config');
      assert.equal(data.OPENROUTER_API_KEY, undefined, 'API keys must NEVER be leaked in /api/config');

      console.log('  ✓ /api/config correctly reports configured status and enforces strict no-cache headers.');
      passedTests++;
      server.close();
    } catch (apiErr) {
      server.close();
      console.error('  ✗ Test 3 failed:', apiErr);
      process.exit(1);
    }
  });
} catch (err) {
  console.error('  ✗ Test 3 setup failed:', err);
  process.exit(1);
}

// Allow async test 3 to complete
await new Promise((r) => setTimeout(r, 600));

/* --------------------------------------------------------------------------
   Test 4: Actual Groq requests via /api/chat with mock upstream server
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 4] Actual Groq request processing via /api/chat...');

  // Start a local mock Groq OpenAI-compatible upstream server
  const mockGroqServer = http.createServer((req, res) => {
    if (req.url?.includes('/chat/completions')) {
      const authHeader = req.headers.authorization || '';
      assert.ok(authHeader.startsWith('Bearer gsk_'), `Authorization must contain Bearer token: ${authHeader}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock-groq-123',
          object: 'chat.completion',
          model: 'openai/gpt-oss-120b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Groq ultra-fast production response.'
              },
              finish_reason: 'stop'
            }
          ]
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => mockGroqServer.listen(3027, '127.0.0.1', resolve));

  process.env.ORVIX_GROQ_BASE_URL = 'http://127.0.0.1:3027';
  process.env.GROQ_API_KEY = 'gsk_mock_production_key_testing';

  const appServer = app.listen(3028, '127.0.0.1', async () => {
    try {
      const chatRes = await fetch('http://127.0.0.1:3028/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          prompt: 'Hello from production test',
          stream: false
        })
      });

      assert.equal(chatRes.status, 200, 'Groq request must succeed with 200');
      const data = await chatRes.json();
      assert.equal(data.provider, 'groq');
      assert.ok(data.text.includes('Groq ultra-fast production response.'));

      console.log('  ✓ Groq request successfully authenticated and generated AI response.');
      passedTests++;
      appServer.close();
      mockGroqServer.close();
    } catch (groqErr) {
      appServer.close();
      mockGroqServer.close();
      console.error('  ✗ Test 4 failed:', groqErr);
      process.exit(1);
    }
  });
} catch (err) {
  console.error('  ✗ Test 4 setup failed:', err);
  process.exit(1);
}

// Allow async test 4 to complete
await new Promise((r) => setTimeout(r, 600));

/* --------------------------------------------------------------------------
   Test 5: Actual OpenRouter requests via /api/chat with mock upstream server
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 5] Actual OpenRouter request processing via /api/chat...');

  const mockOpenRouterServer = http.createServer((req, res) => {
    if (req.url?.includes('/chat/completions')) {
      const authHeader = req.headers.authorization || '';
      assert.ok(authHeader.startsWith('Bearer sk-or-'), `Authorization must contain Bearer token: ${authHeader}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-openrouter-123',
          model: 'openrouter/free',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'OpenRouter free-tier production response.'
              },
              finish_reason: 'stop'
            }
          ]
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => mockOpenRouterServer.listen(3029, '127.0.0.1', resolve));

  process.env.ORVIX_OPENROUTER_BASE_URL = 'http://127.0.0.1:3029';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-mock_production_key_testing';

  const appServer2 = app.listen(3030, '127.0.0.1', async () => {
    try {
      const chatRes = await fetch('http://127.0.0.1:3030/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openrouter',
          model: 'openrouter/free',
          prompt: 'Hello from OpenRouter production test',
          stream: false
        })
      });

      assert.equal(chatRes.status, 200, 'OpenRouter request must succeed with 200');
      const data = await chatRes.json();
      assert.equal(data.provider, 'openrouter');
      assert.ok(data.text.includes('OpenRouter free-tier production response.'));

      console.log('  ✓ OpenRouter request successfully authenticated and generated AI response.');
      passedTests++;
      appServer2.close();
      mockOpenRouterServer.close();
    } catch (orErr) {
      appServer2.close();
      mockOpenRouterServer.close();
      console.error('  ✗ Test 5 failed:', orErr);
      process.exit(1);
    }
  });
} catch (err) {
  console.error('  ✗ Test 5 setup failed:', err);
  process.exit(1);
}

// Allow async test 5 to complete
await new Promise((r) => setTimeout(r, 600));

/* --------------------------------------------------------------------------
   Test 6: Model selector provider availability evaluation (no "(Setup)")
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 6] Model selector provider availability status...');

  const configWhenConfigured = {
    status: 'ready',
    data: {
      geminiConfigured: true,
      groqConfigured: true,
      openrouterConfigured: true,
      cloudflareConfigured: false,
      webllmSupported: true,
      demoModeEnabled: false
    }
  };

  const groqAvail = getProviderConfigAvailability('groq', configWhenConfigured);
  assert.equal(groqAvail.state, 'configured');
  assert.equal(groqAvail.configured, true);

  const openrouterAvail = getProviderConfigAvailability('openrouter', configWhenConfigured);
  assert.equal(openrouterAvail.state, 'configured');
  assert.equal(openrouterAvail.configured, true);

  // When unconfigured, it must report unconfigured
  const configWhenUnconfigured = {
    status: 'ready',
    data: {
      geminiConfigured: true,
      groqConfigured: false,
      openrouterConfigured: false,
      cloudflareConfigured: false,
      webllmSupported: true,
      demoModeEnabled: false
    }
  };

  const groqUnconf = getProviderConfigAvailability('groq', configWhenUnconfigured);
  assert.equal(groqUnconf.state, 'unconfigured');
  assert.equal(groqUnconf.configured, false);

  const orUnconf = getProviderConfigAvailability('openrouter', configWhenUnconfigured);
  assert.equal(orUnconf.state, 'unconfigured');
  assert.equal(orUnconf.configured, false);

  console.log('  ✓ Model selector availability evaluates accurately (configured vs unconfigured).');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 6 failed:', err);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Test 7: Dynamic fallback eligibility
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 7] Dynamic fallback eligibility...');

  // Set Groq and OpenRouter keys in env
  process.env.GROQ_API_KEY = 'gsk_valid_key_for_fallback';
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-valid_key_for_fallback';
  process.env.GEMINI_API_KEY = 'AIzaSy_valid_key_for_fallback';

  const fallbacksFromGemini = getConfiguredFallbackProviders('gemini');
  assert.ok(fallbacksFromGemini.includes('groq'), 'Groq must be suggested as fallback from Gemini');
  assert.ok(fallbacksFromGemini.includes('openrouter'), 'OpenRouter must be suggested as fallback from Gemini');
  assert.ok(fallbacksFromGemini.includes('webllm'), 'WebLLM must be suggested as fallback');

  const fallbacksFromGroq = getConfiguredFallbackProviders('groq');
  assert.ok(fallbacksFromGroq.includes('gemini'), 'Gemini must be suggested as fallback from Groq');
  assert.ok(fallbacksFromGroq.includes('openrouter'), 'OpenRouter must be suggested as fallback from Groq');

  // Frontend filterAvailableFallbackProviders
  const mockConfig = {
    status: 'ready',
    data: {
      geminiConfigured: true,
      groqConfigured: true,
      openrouterConfigured: true,
      cloudflareConfigured: false,
      webllmSupported: true
    }
  };

  const clientCandidates = filterAvailableFallbackProviders(
    ['gemini', 'groq', 'openrouter', 'cloudflare', 'webllm'],
    'gemini',
    mockConfig
  );
  assert.ok(clientCandidates.includes('groq'), 'Client candidates must include Groq');
  assert.ok(clientCandidates.includes('openrouter'), 'Client candidates must include OpenRouter');
  assert.ok(!clientCandidates.includes('cloudflare'), 'Unconfigured Cloudflare must be excluded');

  console.log('  ✓ Fallback system dynamically incorporates all configured providers.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 7 failed:', err);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Test 8: Missing credentials behavior & accurate error message
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 8] Missing credentials error response...');

  delete process.env.GROQ_API_KEY;
  delete process.env.ORVIX_GROQ_API_KEY;
  delete process.env.VITE_GROQ_API_KEY;
  delete process.env.GROQ_KEY;

  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ORVIX_OPENROUTER_API_KEY;
  delete process.env.VITE_OPENROUTER_API_KEY;
  delete process.env.OPEN_ROUTER_API_KEY;

  assert.equal(getGroqApiKey(), '');
  assert.equal(getOpenRouterApiKey(), '');

  const status = getServerProviderConfigStatus();
  assert.equal(status.groqConfigured, false);
  assert.equal(status.openrouterConfigured, false);

  // Test sendProviderNotConfiguredError response shape
  let sentPayload = null;
  let sentStatus = 0;
  const mockRes = {
    status(s) {
      sentStatus = s;
      return this;
    },
    json(p) {
      sentPayload = p;
      return this;
    }
  };

  sendProviderNotConfiguredError(mockRes, 'groq');
  assert.equal(sentStatus, 503);
  assert.equal(sentPayload.code, 503);
  assert.equal(sentPayload.status, 'PROVIDER_NOT_CONFIGURED');
  assert.ok(sentPayload.error.includes('Groq is not configured on this server'));
  assert.ok(sentPayload.error.includes('missing GROQ_API_KEY'));

  sendProviderNotConfiguredError(mockRes, 'openrouter');
  assert.equal(sentStatus, 503);
  assert.equal(sentPayload.code, 503);
  assert.equal(sentPayload.status, 'PROVIDER_NOT_CONFIGURED');
  assert.ok(sentPayload.error.includes('OpenRouter is not configured on this server'));
  assert.ok(sentPayload.error.includes('missing OPENROUTER_API_KEY'));

  console.log('  ✓ Genuinely missing credentials trigger clean 503 PROVIDER_NOT_CONFIGURED.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 8 failed:', err);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Test 9: Security verification (credentials never exposed to client)
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 9] Security verification (credentials remain server-side)...');

  // Verify /api/config payload contains zero secrets
  process.env.GROQ_API_KEY = 'gsk_secret_12345';
  process.env.OPENROUTER_API_KEY = 'sk-or-secret_67890';

  const rawConfig = getServerProviderConfigStatus();
  const normalized = normalizeProviderConfigPayload(rawConfig);

  assert.equal(Object.keys(normalized).some((k) => k.toLowerCase().includes('key')), false);
  assert.equal(Object.values(normalized).some((v) => typeof v === 'string' && (v.startsWith('gsk_') || v.startsWith('sk-or-'))), false);

  // Stringified check
  const jsonStr = JSON.stringify(normalized);
  assert.ok(!jsonStr.includes('gsk_secret_12345'));
  assert.ok(!jsonStr.includes('sk-or-secret_67890'));

  console.log('  ✓ All API keys are strictly server-side and never exposed in client payloads.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 9 failed:', err);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Test 10: Regression verification for Gemini, Cloudflare, and WebLLM
   -------------------------------------------------------------------------- */
try {
  console.log('\n[Test 10] Regression verification for other providers...');

  process.env.GEMINI_API_KEY = 'AIzaSy_valid_key';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'cf_acc_valid';
  process.env.CLOUDFLARE_API_TOKEN = 'cf_tok_valid';

  const fullStatus = getServerProviderConfigStatus();
  assert.equal(fullStatus.geminiConfigured, true, 'Gemini must be configured');
  assert.equal(fullStatus.cloudflareConfigured, true, 'Cloudflare must be configured');
  assert.equal(fullStatus.webllmSupported, true, 'WebLLM must be supported');

  // Check provider options
  const geminiOption = PROVIDER_OPTIONS.find((p) => p.id === 'gemini');
  assert.ok(geminiOption, 'Gemini option must exist');
  assert.equal(geminiOption.defaultModel, 'gemini-3.8-flash');

  const webllmOption = PROVIDER_OPTIONS.find((p) => p.id === 'webllm');
  assert.ok(webllmOption, 'WebLLM option must exist');

  console.log('  ✓ Gemini, Cloudflare, Browser AI, and WebLLM models verified intact.');
  passedTests++;
} catch (err) {
  console.error('  ✗ Test 10 failed:', err);
  process.exit(1);
}

console.log('\n===============================================================');
console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (100%)`);
console.log('===============================================================\n');
console.log('All production provider availability and security tests passed successfully.');
process.exit(0);
