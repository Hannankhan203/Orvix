/**
 * Verification Suite for Supabase Server-Side Configuration
 * Tests:
 * 1. Safe handling of missing configuration
 * 2. Rejection of placeholder credentials
 * 3. Default bucket fallback ('orvix-attachments') vs custom bucket
 * 4. Validation of URL syntax
 * 5. Secret key is strictly server-side and never exposed in client/status objects
 * 6. Singleton instantiation and caching
 */

import assert from 'assert/strict';
import {
  validateSupabaseConfig,
  isSupabaseConfigured,
  getSupabaseStatus,
  getSupabaseBucket,
  getSupabaseServerClient,
  resetSupabaseClientForTesting
} from '../server/supabaseClient.ts';
import {
  getSupabaseUrl,
  getSupabaseSecretKey,
  getSupabaseStorageBucket,
  DEFAULT_SUPABASE_STORAGE_BUCKET,
  getServerProviderConfigStatus
} from '../server/serverConfig.ts';

console.log('=== RUNNING SUPABASE SERVER CONFIGURATION VERIFICATION SUITE ===\n');

// Save original environment
const originalEnv = { ...process.env };

function restoreEnv() {
  resetSupabaseClientForTesting();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;
  delete process.env.ORVIX_SUPABASE_URL;
  delete process.env.ORVIX_SUPABASE_SECRET_KEY;
  delete process.env.ORVIX_SUPABASE_STORAGE_BUCKET;
}

try {
  // Test 1: Missing environment variables handled safely without throwing
  console.log('[Test 1] Missing environment variables handled safely...');
  restoreEnv();

  const validation = validateSupabaseConfig();
  assert.equal(validation.valid, false, 'Validation should fail when env vars are missing');
  assert.ok(validation.error && validation.error.includes('Missing SUPABASE_URL'));
  assert.equal(isSupabaseConfigured(), false, 'isSupabaseConfigured should return false');
  assert.equal(getSupabaseServerClient(), null, 'Client should be null when unconfigured');

  const status = getSupabaseStatus();
  assert.equal(status.isConfigured, false);
  assert.equal(status.bucket, DEFAULT_SUPABASE_STORAGE_BUCKET);
  assert.equal(status.error, validation.error);
  console.log('  ✓ Missing configuration returns valid: false and null client safely.');

  // Test 2: Placeholder credentials rejected
  console.log('\n[Test 2] Placeholder credentials rejected...');
  restoreEnv();
  process.env.SUPABASE_URL = 'https://your-project.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'your_supabase_secret_key';

  const placeholderValidation = validateSupabaseConfig();
  assert.equal(placeholderValidation.valid, false, 'Placeholder secret key must be rejected');
  assert.ok(placeholderValidation.error.includes('placeholder'), 'Error should identify placeholder value');
  assert.equal(getSupabaseServerClient(), null, 'Client must remain null for placeholder values');
  console.log('  ✓ Placeholder secret key properly rejected as unconfigured.');

  // Test 3: Invalid URL format rejected safely
  console.log('\n[Test 3] Invalid URL format rejected...');
  restoreEnv();
  process.env.SUPABASE_URL = 'not-a-valid-url';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_token_12345';

  const invalidUrlValidation = validateSupabaseConfig();
  assert.equal(invalidUrlValidation.valid, false, 'Invalid URL must fail validation');
  assert.ok(invalidUrlValidation.error.includes('Invalid SUPABASE_URL'));
  assert.equal(getSupabaseServerClient(), null, 'Client must be null for invalid URL');
  console.log('  ✓ Malformed URL safely handled without unhandled exception.');

  // Test 4: Default bucket is 'orvix-attachments'
  console.log('\n[Test 4] Default bucket fallback...');
  restoreEnv();
  assert.equal(getSupabaseBucket(), 'orvix-attachments');
  assert.equal(DEFAULT_SUPABASE_STORAGE_BUCKET, 'orvix-attachments');
  assert.equal(getSupabaseStorageBucket(), 'orvix-attachments');

  // Custom bucket override
  process.env.SUPABASE_STORAGE_BUCKET = 'custom-user-bucket';
  assert.equal(getSupabaseBucket(), 'custom-user-bucket');
  assert.equal(getSupabaseStorageBucket(), 'custom-user-bucket');
  console.log('  ✓ Bucket defaults to orvix-attachments and respects custom override.');

  // Test 5: Security - Secret key is never exposed
  console.log('\n[Test 5] Security - Secret key is strictly private...');
  restoreEnv();
  const testSecret = 'sb_super_secret_production_key_xyz987';
  process.env.SUPABASE_URL = 'https://abcdefghijklm.supabase.co';
  process.env.SUPABASE_SECRET_KEY = testSecret;

  const validStatus = getSupabaseStatus();
  const statusString = JSON.stringify(validStatus);
  assert.ok(!statusString.includes(testSecret), 'Status object must not leak secret key');
  assert.equal('secretKey' in validStatus, false, 'secretKey property must not exist in status');
  assert.equal('key' in validStatus, false, 'key property must not exist in status');

  const providerStatus = getServerProviderConfigStatus();
  const providerStatusString = JSON.stringify(providerStatus);
  assert.ok(!providerStatusString.includes(testSecret), 'Provider config status must not leak secret key');
  assert.equal(providerStatus.supabaseConfigured, true, 'supabaseConfigured should be true');
  console.log('  ✓ Secret key is strictly server-side and never exposed in client/status objects.');

  // Test 6: Valid credentials initialize SupabaseClient singleton
  console.log('\n[Test 6] Valid client initialization and singleton caching...');
  resetSupabaseClientForTesting();
  const client1 = getSupabaseServerClient();
  assert.ok(client1 !== null, 'Client must be instantiated for valid configuration');
  assert.ok(typeof client1.storage === 'object', 'Client must have storage subsystem');

  const client2 = getSupabaseServerClient();
  assert.equal(client1, client2, 'Successive calls must return the same cached singleton instance');

  resetSupabaseClientForTesting();
  console.log('  ✓ Supabase server client instantiated successfully with singleton caching.');

  console.log('\n======================================================');
  console.log('✓ ALL 6 SUPABASE SERVER CONFIGURATION TESTS PASSED!');
  console.log('======================================================');
} finally {
  // Restore original environment
  restoreEnv();
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v !== undefined) {
      process.env[k] = v;
    }
  }
}
