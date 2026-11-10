/**
 * Automated Verification Suite for Supabase Storage Bucket Auto-Provisioning
 *
 * Verifies:
 * 1. Safe handling when Supabase is unconfigured (returns status 503 without throwing)
 * 2. Idempotent check for an already existing bucket (never alters privacy or config)
 * 3. Automatic creation of a missing bucket as PRIVATE ({ public: false })
 * 4. Concurrent startup deduplication and graceful handling of 409/already-exists race conditions
 * 5. Upstream API failure handling (returns structured error safely without leaking credentials)
 * 6. Integration with uploadAttachmentToStorage auto-retry on bucket-not-found error
 */

import assert from 'node:assert/strict';
import {
  ensureSupabaseBucketExists,
  resetBucketProvisioningForTesting,
  resetSupabaseClientForTesting,
  setSupabaseServerClientForTesting,
  uploadAttachmentToStorage
} from '../server/supabaseClient.ts';

console.log('=== RUNNING SUPABASE BUCKET AUTO-PROVISIONING VERIFICATION SUITE ===\n');

const originalEnv = { ...process.env };

function clearEnv() {
  resetSupabaseClientForTesting();
  resetBucketProvisioningForTesting();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_STORAGE_BUCKET;
  delete process.env.ORVIX_SUPABASE_URL;
  delete process.env.ORVIX_SUPABASE_SECRET_KEY;
  delete process.env.ORVIX_SUPABASE_STORAGE_BUCKET;
}

let passedCount = 0;

async function runTests() {
  try {
    // -------------------------------------------------------------------------
    // Test 1: Missing Configuration
    // -------------------------------------------------------------------------
    console.log('[Test 1] Missing configuration handled safely...');
    clearEnv();

    const unconfiguredRes = await ensureSupabaseBucketExists();
    assert.equal(unconfiguredRes.success, false, 'Should fail gracefully when unconfigured');
    assert.equal(unconfiguredRes.isConfigured, false);
    assert.equal(unconfiguredRes.created, false);
    assert.equal(unconfiguredRes.alreadyExisted, false);
    assert.equal(unconfiguredRes.code, 'STORAGE_UNCONFIGURED');
    assert.equal(unconfiguredRes.status, 503);
    assert.ok(unconfiguredRes.error && unconfiguredRes.error.includes('not configured'));
    passedCount++;
    console.log('  ✓ Unconfigured Supabase returns status 503 without throwing.');

    // -------------------------------------------------------------------------
    // Test 2: Existing Bucket Check
    // -------------------------------------------------------------------------
    console.log('\n[Test 2] Existing bucket check preserves existing configuration...');
    clearEnv();

    let getBucketCalls = 0;
    let createBucketCalls = 0;

    const mockClientExisting = {
      storage: {
        getBucket: async (name) => {
          getBucketCalls++;
          assert.equal(name, 'orvix-attachments');
          return { data: { id: 'orvix-attachments', name: 'orvix-attachments', public: false }, error: null };
        },
        createBucket: async () => {
          createBucketCalls++;
          throw new Error('createBucket should not be called when bucket exists!');
        }
      }
    };

    setSupabaseServerClientForTesting(mockClientExisting, 'https://test-project.supabase.co', 'test-secret-key-12345');

    const existingRes = await ensureSupabaseBucketExists('orvix-attachments', { forceRefresh: true });
    assert.equal(existingRes.success, true);
    assert.equal(existingRes.bucket, 'orvix-attachments');
    assert.equal(existingRes.created, false);
    assert.equal(existingRes.alreadyExisted, true);
    assert.equal(existingRes.isConfigured, true);
    assert.equal(existingRes.error, null);
    assert.equal(getBucketCalls, 1);
    assert.equal(createBucketCalls, 0, 'Must never attempt to recreate or alter existing bucket');
    passedCount++;
    console.log('  ✓ Existing bucket identified without calling createBucket or changing settings.');

    // -------------------------------------------------------------------------
    // Test 3: Missing Bucket Auto-Creation as PRIVATE
    // -------------------------------------------------------------------------
    console.log('\n[Test 3] Missing bucket auto-provisioned as PRIVATE ({ public: false })...');
    clearEnv();

    let createOptionsCaptured = null;
    let createdBucketName = null;

    const mockClientMissing = {
      storage: {
        getBucket: async () => ({
          data: null,
          error: { message: 'The resource was not found', status: 404 }
        }),
        createBucket: async (name, options) => {
          createdBucketName = name;
          createOptionsCaptured = options;
          return { data: { name }, error: null };
        }
      }
    };

    setSupabaseServerClientForTesting(mockClientMissing, 'https://test-project.supabase.co', 'test-secret-key-12345');

    const createRes = await ensureSupabaseBucketExists('orvix-attachments', { forceRefresh: true });
    assert.equal(createRes.success, true);
    assert.equal(createRes.created, true);
    assert.equal(createRes.alreadyExisted, false);
    assert.equal(createRes.bucket, 'orvix-attachments');
    assert.equal(createdBucketName, 'orvix-attachments');
    assert.deepEqual(createOptionsCaptured, { public: false }, 'Must create bucket as strictly PRIVATE');
    passedCount++;
    console.log('  ✓ Missing bucket auto-created with { public: false } privacy.');

    // -------------------------------------------------------------------------
    // Test 4: Concurrent Startup & Race Condition (409 Already Exists)
    // -------------------------------------------------------------------------
    console.log('\n[Test 4] Concurrent startup attempts deduplicated and race conditions handled...');
    clearEnv();

    let concurrentGetCalls = 0;
    let concurrentCreateCalls = 0;

    const mockClientConcurrent = {
      storage: {
        getBucket: async () => {
          concurrentGetCalls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { data: null, error: { message: 'Not found', status: 404 } };
        },
        createBucket: async (name) => {
          concurrentCreateCalls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { data: { name }, error: null };
        }
      }
    };

    setSupabaseServerClientForTesting(mockClientConcurrent, 'https://test-project.supabase.co', 'test-secret-key-12345');

    // Launch 3 simultaneous calls
    const [resA, resB, resC] = await Promise.all([
      ensureSupabaseBucketExists('orvix-attachments'),
      ensureSupabaseBucketExists('orvix-attachments'),
      ensureSupabaseBucketExists('orvix-attachments')
    ]);

    assert.equal(resA.success, true);
    assert.equal(resB.success, true);
    assert.equal(resC.success, true);
    assert.equal(concurrentGetCalls, 1, 'In-flight calls should be deduplicated to 1 getBucket call');
    assert.equal(concurrentCreateCalls, 1, 'In-flight calls should be deduplicated to 1 createBucket call');

    // Next call should use verified in-memory cache without hitting network
    const cachedRes = await ensureSupabaseBucketExists('orvix-attachments');
    assert.equal(cachedRes.success, true);
    assert.equal(cachedRes.alreadyExisted, true);
    assert.equal(concurrentGetCalls, 1, 'Cached bucket check should not invoke getBucket');

    // Test 4b: Race condition where createBucket returns 409 already exists
    resetBucketProvisioningForTesting();
    const mockClientRace409 = {
      storage: {
        getBucket: async () => ({ data: null, error: { message: 'Not found', status: 404 } }),
        createBucket: async () => ({
          data: null,
          error: { message: 'Bucket already exists', status: 409 }
        })
      }
    };
    setSupabaseServerClientForTesting(mockClientRace409, 'https://test-project.supabase.co', 'test-secret-key-12345');

    const raceRes = await ensureSupabaseBucketExists('orvix-attachments', { forceRefresh: true });
    assert.equal(raceRes.success, true, '409 Bucket already exists should be handled as success');
    assert.equal(raceRes.alreadyExisted, true);
    assert.equal(raceRes.created, false);
    passedCount++;
    console.log('  ✓ Concurrent calls deduplicated and 409 race conditions handled as success.');

    // -------------------------------------------------------------------------
    // Test 5: Upstream API Failure Handling
    // -------------------------------------------------------------------------
    console.log('\n[Test 5] Upstream API failure handled safely without exposing credentials...');
    clearEnv();

    const mockClientFailing = {
      storage: {
        getBucket: async () => ({ data: null, error: { message: 'Not found', status: 404 } }),
        createBucket: async () => ({
          data: null,
          error: { message: 'Supabase storage upstream connection timeout', status: 504 }
        })
      }
    };

    setSupabaseServerClientForTesting(mockClientFailing, 'https://test-project.supabase.co', 'test-secret-key-12345');

    const failRes = await ensureSupabaseBucketExists('orvix-attachments', { forceRefresh: true });
    assert.equal(failRes.success, false);
    assert.equal(failRes.status, 504);
    assert.ok(failRes.error && failRes.error.includes('timeout'));
    assert.ok(!failRes.error.includes('test-secret-key-12345'), 'Must never leak secret keys');
    passedCount++;
    console.log('  ✓ Upstream failures return structured error without credential exposure.');

    // -------------------------------------------------------------------------
    // Test 6: uploadAttachmentToStorage Auto-Retry Integration
    // -------------------------------------------------------------------------
    console.log('\n[Test 6] uploadAttachmentToStorage triggers auto-provisioning and retries on 404...');
    clearEnv();

    let uploadAttempts = 0;
    let provisionedDuringUpload = false;

    const mockClientUpload = {
      storage: {
        getBucket: async () => {
          if (!provisionedDuringUpload) {
            return { data: null, error: { message: 'The resource was not found', status: 404 } };
          }
          return { data: { name: 'orvix-attachments' }, error: null };
        },
        createBucket: async (name) => {
          provisionedDuringUpload = true;
          return { data: { name }, error: null };
        },
        from: (bucket) => ({
          upload: async (storagePath, buffer) => {
            uploadAttempts++;
            if (!provisionedDuringUpload) {
              return { data: null, error: { message: 'Bucket not found', status: 404 } };
            }
            return { data: { path: storagePath, fullPath: `${bucket}/${storagePath}` }, error: null };
          }
        })
      }
    };

    setSupabaseServerClientForTesting(mockClientUpload, 'https://test-project.supabase.co', 'test-secret-key-12345');

    const uploadRes = await uploadAttachmentToStorage({
      userId: 'user123',
      chatId: 'chat456',
      attachmentId: 'att789',
      extension: 'png',
      buffer: Buffer.from('test-image-data'),
      mimeType: 'image/png'
    });

    assert.equal(uploadRes.success, true);
    assert.equal(uploadAttempts, 2, 'Should attempt upload, fail with 404, provision bucket, and retry upload');
    assert.equal(provisionedDuringUpload, true);
    passedCount++;
    console.log('  ✓ uploadAttachmentToStorage automatically provisioned missing bucket and succeeded on retry.');

    console.log(`\n=== RESULTS: ${passedCount}/6 TESTS PASSED, 0 FAILED ===`);
  } catch (err) {
    console.error('\n❌ Test failure:', err);
    process.exit(1);
  } finally {
    clearEnv();
    Object.assign(process.env, originalEnv);
  }
}

runTests();
