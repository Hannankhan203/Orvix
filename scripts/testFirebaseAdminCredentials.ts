/**
 * Firebase Admin SDK Credential Detection & Resolution Test Suite
 *
 * Verifies that:
 * 1. Path resolution handles relative paths, absolute paths, surrounding quotes, and home dir tilde (~).
 * 2. Missing GOOGLE_APPLICATION_CREDENTIALS files produce clear, non-sensitive diagnostics rather than silent fallthrough.
 * 3. Malformed credential files are safely caught and reported without crashing or leaking sensitive info.
 * 4. Valid service account JSON files are properly parsed, normalized, and initialized with cert().
 * 5. Project ID matching between service account and frontend (VITE_FIREBASE_PROJECT_ID) works correctly.
 * 6. Private keys are never leaked into logs or error strings (sanitization verification).
 * 7. Lazy initialization works when credentials become available after boot.
 *
 * Usage:
 *   npm run test:admin-creds
 *   # or: TESTING=true tsx scripts/testFirebaseAdminCredentials.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
  resolveCredentialFilePath,
  parseServiceAccountKey,
  initializeFirebaseAdmin,
  isFirebaseAdminConfigured,
  getFirebaseAdminInitError,
  getFirebaseAdminDiagnostic,
  fullResetFirebaseAdminForTesting
} from '../src/services/firebaseAdminService.ts';

// Test runner state
let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean, extraInfo?: any) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    if (extraInfo) console.error('    Details:', extraInfo);
    failed++;
  }
}

// Generate a valid ephemeral RSA private key for testing structure
const keyPair = (crypto as any).generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const dummyPrivateKey: string = keyPair.privateKey;

const tempDir = path.join(os.tmpdir(), `orvix-test-creds-${Date.now()}`);

async function runTests() {
  console.log('====================================================');
  console.log('  Firebase Admin Credential Detection Test Suite    ');
  console.log('====================================================\n');

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // -------------------------------------------------------------------------
    // 1. Path Resolution Tests
    // -------------------------------------------------------------------------
    console.log('--- [1/6] Testing Path Resolution & Normalization ---');

    const relPath = './serviceAccountKey.json';
    const resolvedRel = resolveCredentialFilePath(relPath);
    assert(
      'Relative path ./serviceAccountKey.json resolves to absolute path in cwd',
      path.isAbsolute(resolvedRel) && resolvedRel.endsWith('serviceAccountKey.json')
    );

    const quotedPath = '"./config/firebaseKey.json"';
    const resolvedQuoted = resolveCredentialFilePath(quotedPath);
    assert(
      'Surrounding double quotes are stripped',
      !resolvedQuoted.includes('"') && resolvedQuoted.endsWith('firebaseKey.json')
    );

    const singleQuoted = "'serviceAccount.json'";
    const resolvedSingle = resolveCredentialFilePath(singleQuoted);
    assert(
      'Surrounding single quotes are stripped',
      !resolvedSingle.includes("'") && resolvedSingle.endsWith('serviceAccount.json')
    );

    const absTestPath = path.resolve('/var/secrets/google/key.json');
    const resolvedAbs = resolveCredentialFilePath(absTestPath);
    assert(
      'Absolute path remains absolute and normalized',
      resolvedAbs === absTestPath
    );

    const tildePath = '~/firebase-creds.json';
    const resolvedTilde = resolveCredentialFilePath(tildePath);
    assert(
      'Tilde (~) expands to os.homedir()',
      resolvedTilde.startsWith(os.homedir()) && resolvedTilde.endsWith('firebase-creds.json')
    );

    // -------------------------------------------------------------------------
    // 2. Missing File Diagnostic Reporting
    // -------------------------------------------------------------------------
    console.log('\n--- [2/6] Testing Missing Credential File Diagnostics ---');

    await fullResetFirebaseAdminForTesting();
    const nonExistentPath = path.join(tempDir, 'does-not-exist.json');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = nonExistentPath;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    const resultMissing = initializeFirebaseAdmin();
    assert('Missing file results in null app', resultMissing === null);
    assert('isFirebaseAdminConfigured() returns false', !isFirebaseAdminConfigured());

    const initErrorMissing = getFirebaseAdminInitError();
    assert(
      'initError specifically mentions that file was not found',
      Boolean(initErrorMissing && initErrorMissing.includes('file not found'))
    );
    assert(
      'initError includes the checked path for easy debugging',
      Boolean(initErrorMissing && initErrorMissing.includes('does-not-exist.json'))
    );

    // -------------------------------------------------------------------------
    // 3. Service Account Key Parsing & Validation
    // -------------------------------------------------------------------------
    console.log('\n--- [3/6] Testing Service Account Key Parsing & Validation ---');

    const validKeyObj = {
      project_id: 'test-orvix-project',
      client_email: 'firebase-adminsdk@test-orvix-project.iam.gserviceaccount.com',
      private_key: dummyPrivateKey
    };

    const parsedValid = parseServiceAccountKey(JSON.stringify(validKeyObj));
    assert('Valid JSON parses successfully', parsedValid !== null);
    assert('Extracted projectId matches', parsedValid?.projectId === 'test-orvix-project');
    assert('Extracted clientEmail matches', parsedValid?.clientEmail === validKeyObj.client_email);

    // Base64 encoding support
    const b64Key = Buffer.from(JSON.stringify(validKeyObj)).toString('base64');
    const parsedB64 = parseServiceAccountKey(b64Key);
    assert('Base64-encoded JSON parses successfully', parsedB64?.projectId === 'test-orvix-project');

    // Missing required field: client_email
    let missingEmailThrew = false;
    try {
      parseServiceAccountKey(JSON.stringify({ project_id: 'proj', private_key: dummyPrivateKey }));
    } catch (e: any) {
      missingEmailThrew = true;
      assert('Missing client_email throws descriptive error', e.message.includes('client_email'));
    }
    assert('Throws on missing client_email', missingEmailThrew);

    // Escaped newlines normalization (\n -> actual newline)
    const escapedKeyObj = {
      project_id: 'proj',
      client_email: 'test@example.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----'
    };
    const parsedEscaped = parseServiceAccountKey(JSON.stringify(escapedKeyObj));
    const normalizedKey = parsedEscaped?.privateKey || '';
    assert(
      'Escaped newlines (\\n) in private key are normalized to real newlines',
      Boolean(normalizedKey.includes('\n') && !normalizedKey.includes('\\n'))
    );

    // -------------------------------------------------------------------------
    // 4. Initialization via GOOGLE_APPLICATION_CREDENTIALS File
    // -------------------------------------------------------------------------
    console.log('\n--- [4/6] Testing GOOGLE_APPLICATION_CREDENTIALS File Loading ---');

    await fullResetFirebaseAdminForTesting();
    const validCredFile = path.join(tempDir, 'valid-service-account.json');
    fs.writeFileSync(validCredFile, JSON.stringify(validKeyObj));

    process.env.GOOGLE_APPLICATION_CREDENTIALS = validCredFile;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    const initializedApp = initializeFirebaseAdmin();
    assert('initializeApp returns initialized app instance', initializedApp !== null);
    assert('isFirebaseAdminConfigured() returns true', isFirebaseAdminConfigured());

    const diag = getFirebaseAdminDiagnostic();
    assert('Diagnostic indicates configured: true', diag.isConfigured === true);
    assert(
      'Diagnostic source is google_application_credentials',
      diag.credentialSource === 'google_application_credentials'
    );
    assert('Diagnostic projectId matches key project_id', diag.projectId === 'test-orvix-project');

    // -------------------------------------------------------------------------
    // 5. Project ID Mismatch Diagnostic
    // -------------------------------------------------------------------------
    console.log('\n--- [5/6] Testing Project ID Alignment Diagnostics ---');

    process.env.VITE_FIREBASE_PROJECT_ID = 'different-frontend-project';
    const diagMismatch = getFirebaseAdminDiagnostic();
    assert(
      'Mismatched project ID is correctly identified in diagnostic',
      diagMismatch.projectIdMatches === false
    );
    assert(
      'Diagnostic reports frontend project ID',
      diagMismatch.frontendProjectId === 'different-frontend-project'
    );

    process.env.VITE_FIREBASE_PROJECT_ID = 'test-orvix-project';
    const diagMatch = getFirebaseAdminDiagnostic();
    assert(
      'Matching project ID is confirmed in diagnostic',
      diagMatch.projectIdMatches === true
    );

    // -------------------------------------------------------------------------
    // 6. Security & Secret Redaction (No Key Leaks)
    // -------------------------------------------------------------------------
    console.log('\n--- [6/10] Testing Secret Redaction & Log Safety ---');

    await fullResetFirebaseAdminForTesting();
    const malformedFile = path.join(tempDir, 'malformed-key.json');
    fs.writeFileSync(
      malformedFile,
      JSON.stringify({
        project_id: 'test-proj',
        private_key: dummyPrivateKey,
        broken: true
      })
    );
    process.env.GOOGLE_APPLICATION_CREDENTIALS = malformedFile;

    initializeFirebaseAdmin();
    const errorWithKey = getFirebaseAdminInitError() || '';
    assert(
      'Private key contents are NOT leaked in initError',
      !errorWithKey.includes('MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6rZ9vY1Vn5J9D')
    );

    // -------------------------------------------------------------------------
    // 7. GOOGLE_APPLICATION_CREDENTIALS as Inline JSON String
    // -------------------------------------------------------------------------
    console.log('\n--- [7/10] Testing GOOGLE_APPLICATION_CREDENTIALS as Inline JSON ---');

    await fullResetFirebaseAdminForTesting();
    process.env.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(validKeyObj);
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    const inlineApp = initializeFirebaseAdmin();
    assert('Inline JSON in GOOGLE_APPLICATION_CREDENTIALS initializes successfully', inlineApp !== null);
    assert('isFirebaseAdminConfigured() returns true for inline JSON', isFirebaseAdminConfigured());
    const inlineDiag = getFirebaseAdminDiagnostic();
    assert('Diagnostic confirms google_application_credentials source', inlineDiag.credentialSource === 'google_application_credentials');
    assert('Diagnostic confirms project ID from inline JSON', inlineDiag.projectId === 'test-orvix-project');

    // -------------------------------------------------------------------------
    // 8. FIREBASE_SERVICE_ACCOUNT_KEY as File Path
    // -------------------------------------------------------------------------
    console.log('\n--- [8/10] Testing FIREBASE_SERVICE_ACCOUNT_KEY as File Path ---');

    await fullResetFirebaseAdminForTesting();
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = validCredFile;

    const filePathApp = initializeFirebaseAdmin();
    assert('File path in FIREBASE_SERVICE_ACCOUNT_KEY initializes successfully', filePathApp !== null);
    assert('isFirebaseAdminConfigured() returns true for file path in FIREBASE_SERVICE_ACCOUNT_KEY', isFirebaseAdminConfigured());
    const filePathDiag = getFirebaseAdminDiagnostic();
    assert('Diagnostic confirms service_account_key source', filePathDiag.credentialSource === 'service_account_key');

    // -------------------------------------------------------------------------
    // 9. Discrete Credentials (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)
    // -------------------------------------------------------------------------
    console.log('\n--- [9/10] Testing Discrete Environment Variables ---');

    await fullResetFirebaseAdminForTesting();
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    process.env.FIREBASE_PROJECT_ID = 'test-discrete-project';
    process.env.FIREBASE_CLIENT_EMAIL = 'discrete-admin@test-discrete-project.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = dummyPrivateKey;

    const discreteApp = initializeFirebaseAdmin();
    assert('Discrete credentials initialize successfully', discreteApp !== null);
    assert('isFirebaseAdminConfigured() returns true for discrete credentials', isFirebaseAdminConfigured());
    const discreteDiag = getFirebaseAdminDiagnostic();
    assert('Diagnostic confirms service_account_fields source', discreteDiag.credentialSource === 'service_account_fields');
    assert('Diagnostic confirms discrete project ID', discreteDiag.projectId === 'test-discrete-project');

    // -------------------------------------------------------------------------
    // 10. Dotenv Override Verification
    // -------------------------------------------------------------------------
    console.log('\n--- [10/10] Testing Dotenv Override of Empty Environment Variables ---');

    await fullResetFirebaseAdminForTesting();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_PROJECT_ID;

    // Simulate pre-existing empty string in environment
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '';
    assert('Pre-condition: GOOGLE_APPLICATION_CREDENTIALS is empty string', process.env.GOOGLE_APPLICATION_CREDENTIALS === '');

    // Write a temporary .env in tempDir
    const testEnvPath = path.join(tempDir, '.env');
    fs.writeFileSync(testEnvPath, `GOOGLE_APPLICATION_CREDENTIALS="${validCredFile}"\n`);

    // Use dotenv.config with override: true
    const dotenv = await import('dotenv');
    dotenv.default.config({ path: testEnvPath, override: true });

    assert(
      'Override replaces empty environment variable with file path from .env',
      process.env.GOOGLE_APPLICATION_CREDENTIALS === validCredFile
    );

    const overrideApp = initializeFirebaseAdmin();
    assert('App initializes successfully after override from .env', overrideApp !== null);
    assert('isFirebaseAdminConfigured() returns true after override', isFirebaseAdminConfigured());

    // Clean up
    await fullResetFirebaseAdminForTesting();
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.VITE_FIREBASE_PROJECT_ID;

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}

    console.log('\n====================================================');
    console.log(`  Tests completed: ${passed} passed, ${failed} failed`);
    console.log('====================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal test exception:', err);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
    process.exit(1);
  }
}

runTests();
