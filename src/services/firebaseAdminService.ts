/**
 * Orvix Firebase Admin SDK Service (Phase 3 Step 1 & Credential Detection Fix)
 *
 * Provides secure server-side Firebase Authentication ID token verification.
 * Initializes the official firebase-admin SDK using server-side environment variables.
 *
 * Supported Configuration Strategies:
 * 1. FIREBASE_SERVICE_ACCOUNT_KEY: JSON string or Base64-encoded service account key
 * 2. GOOGLE_APPLICATION_CREDENTIALS: File path to a service account JSON file (relative or absolute)
 * 3. FIREBASE_PROJECT_ID / VITE_FIREBASE_PROJECT_ID: Application Default Credentials (ADC)
 *
 * Features:
 * - Early environment variable detection via dotenv
 * - Safe, non-crashing initialization (server boots even if Admin SDK is unconfigured)
 * - Sanitized logging (credentials and private keys are never logged)
 * - Robust path resolution (handles relative paths, home directory tilde, and quotes)
 * - File accessibility & readability checks with actionable non-sensitive diagnostics
 * - Project ID consistency check between frontend (VITE_FIREBASE_PROJECT_ID) and service account
 * - Idempotent initialization and singleton app reuse
 * - Pluggable mock verifier hook for isolated unit testing without external network calls
 */

import {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
  deleteApp,
  type App,
  type ServiceAccount
} from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure environment variables from .env are loaded into process.env upon module import
export function loadEnvironmentVariables(): void {
  try {
    const candidates = [
      path.resolve(process.cwd(), '.env'),
      path.resolve(process.cwd(), '.env.local'),
      path.resolve(process.cwd(), '.env.development'),
      path.resolve(__dirname, '../../.env'),
      path.resolve(__dirname, '../.env'),
      path.resolve(__dirname, '.env')
    ];

    let loaded = false;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate, override: false });
        loaded = true;
      }
    }

    if (!loaded) {
      dotenv.config({ override: false });
    }
  } catch (_) {}
}

if (process.env.TESTING !== 'true') {
  loadEnvironmentVariables();
}

export type FirebaseCredentialSource =
  | 'service_account_key'
  | 'google_application_credentials'
  | 'application_default'
  | 'service_account_fields'
  | 'mock_verifier'
  | 'none';

interface FirebaseAdminState {
  app: App | null;
  auth: Auth | null;
  isConfigured: boolean;
  credentialSource: FirebaseCredentialSource;
  initError: string | null;
  projectId: string | null;
  mockVerifier: ((token: string) => Promise<DecodedIdToken>) | null;
}

const state: FirebaseAdminState = {
  app: null,
  auth: null,
  isConfigured: false,
  credentialSource: 'none',
  initError: null,
  projectId: null,
  mockVerifier: null
};

/**
 * Sanitizes error messages to prevent any sensitive strings from leaking into logs.
 */
function sanitizeError(err: any): string {
  if (!err) return 'Unknown error';
  const raw = String(err?.message || err);
  return raw
    .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_API_KEY]');
}

/**
 * Validates whether the configured service account project ID aligns with the frontend project ID.
 * Logs a non-sensitive diagnostic warning if there is a mismatch.
 */
function checkProjectIdMatch(configuredProjectId: string | null): boolean | null {
  if (!configuredProjectId) return null;
  const frontendProjectId =
    process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;

  if (
    frontendProjectId &&
    frontendProjectId !== 'YOUR_FIREBASE_PROJECT_ID' &&
    frontendProjectId !== configuredProjectId
  ) {
    console.warn(
      `[Firebase Admin] Notice: Service account project ID "${configuredProjectId}" does not match frontend project ID "${frontendProjectId}". Verification will fail if tokens belong to another Firebase project.`
    );
    return false;
  }
  return true;
}

/**
 * Parses and normalizes a service account JSON object from an environment string or file content.
 * Handles raw JSON as well as Base64-encoded strings (common in containerized deployments).
 */
export function parseServiceAccountKey(keyString: string): ServiceAccount | null {
  const trimmed = keyString.trim();
  if (!trimmed) return null;

  let parsed: any = null;

  // Attempt direct JSON parse first
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    // If direct parse fails, check if it's base64 encoded
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      parsed = JSON.parse(decoded);
    } catch (b64Err) {
      throw new Error(`Credential content is neither valid JSON nor valid Base64 JSON: ${sanitizeError(b64Err)}`);
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Parsed service account credential is not a valid JSON object.');
  }

  // Ensure required fields exist
  if (!parsed.project_id && !parsed.projectId) {
    throw new Error('Service account credential is missing "project_id".');
  }
  if (!parsed.client_email && !parsed.clientEmail) {
    throw new Error('Service account credential is missing "client_email".');
  }
  if (!parsed.private_key && !parsed.privateKey) {
    throw new Error('Service account credential is missing "private_key".');
  }

  // Normalize private key escaped newlines (\n -> actual newline)
  const privateKey = (parsed.private_key || parsed.privateKey || '').replace(/\\n/g, '\n');

  return {
    projectId: parsed.project_id || parsed.projectId,
    clientEmail: parsed.client_email || parsed.clientEmail,
    privateKey
  };
}

/**
 * Resolves a credential file path string to an absolute filesystem path.
 * Handles surrounding quotes, whitespace, tilde (~/) expansion, and relative paths.
 */
export function resolveCredentialFilePath(rawPath: string): string {
  const cleaned = rawPath.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return '';

  if (cleaned.startsWith('~/') || cleaned === '~') {
    return path.join(os.homedir(), cleaned.slice(1));
  }

  if (path.isAbsolute(cleaned)) {
    return path.normalize(cleaned);
  }

  // Check if file exists relative to cwd first
  const cwdResolved = path.resolve(process.cwd(), cleaned);
  if (fs.existsSync(cwdResolved)) {
    return cwdResolved;
  }

  // Check relative to project root or __dirname
  const rootResolved = path.resolve(__dirname, '../../', cleaned);
  if (fs.existsSync(rootResolved)) {
    return rootResolved;
  }

  const parentResolved = path.resolve(__dirname, '../', cleaned);
  if (fs.existsSync(parentResolved)) {
    return parentResolved;
  }

  return cwdResolved;
}

/**
 * Determines whether Application Default Credentials (ADC) are genuinely available
 * when no explicit service-account environment variable is configured.
 *
 * Prevents a standalone project ID (e.g., VITE_FIREBASE_PROJECT_ID on Vercel) from
 * falsely marking Firebase Admin as configured without usable credentials.
 */
function hasUsableApplicationDefaultCredentials(): boolean {
  // Vercel and serverless functions do not provide Google Cloud ADC
  if (
    process.env.VERCEL === '1' ||
    Boolean(process.env.VERCEL) ||
    process.env.SERVERLESS === 'true'
  ) {
    return false;
  }

  // Isolated automated tests should not implicitly bind to host ADC unless explicitly configured
  if (process.env.TESTING === 'true') {
    return false;
  }

  // Explicit GCE metadata server host configuration
  if (process.env.GCE_METADATA_HOST && process.env.GCE_METADATA_HOST.trim()) {
    return true;
  }

  // Check standard local gcloud ADC file location (`gcloud auth application-default login`)
  try {
    let adcPath = '';
    if (process.env.CLOUDSDK_CONFIG && process.env.CLOUDSDK_CONFIG.trim()) {
      adcPath = path.join(
        process.env.CLOUDSDK_CONFIG.trim(),
        'application_default_credentials.json'
      );
    } else if (process.platform === 'win32' && process.env.APPDATA) {
      adcPath = path.join(
        process.env.APPDATA,
        'gcloud',
        'application_default_credentials.json'
      );
    } else {
      adcPath = path.join(
        os.homedir(),
        '.config',
        'gcloud',
        'application_default_credentials.json'
      );
    }

    if (adcPath && fs.existsSync(adcPath)) {
      const raw = fs.readFileSync(adcPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.type === 'authorized_user' ||
          parsed.type === 'service_account' ||
          parsed.type === 'external_account' ||
          Boolean(parsed.client_email) ||
          Boolean(parsed.client_id))
      ) {
        return true;
      }
    }
  } catch (_) {
    return false;
  }

  return false;
}

/**
 * Initializes Firebase Admin SDK using available environment credentials.
 * Safe: will not throw or abort server startup if credentials are unconfigured or invalid.
 */
export function initializeFirebaseAdmin(): App | null {
  // If already initialized and configured, return cached instance
  if (state.app && state.isConfigured) {
    return state.app;
  }

  // Always refresh environment variables from .env to pick up newly added credentials
  // (Skip during isolated test runs so in-memory test env overrides are not clobbered by .env on disk)
  if (process.env.TESTING !== 'true') {
    loadEnvironmentVariables();
  }

  // Check if Firebase Admin app has already been initialized on the global instance
  const existingApps = getApps();
  if (existingApps.length > 0 && existingApps[0]) {
    state.app = existingApps[0];
    state.auth = getAuth(state.app);
    state.isConfigured = true;
    state.initError = null;
    return state.app;
  }

  try {
    // -------------------------------------------------------------------------
    // Strategy 1: Explicit Service Account Key in FIREBASE_SERVICE_ACCOUNT_KEY
    // Supports inline JSON, Base64 JSON, or file path to JSON
    // -------------------------------------------------------------------------
    const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccountEnv && serviceAccountEnv.trim()) {
      const trimmed = serviceAccountEnv.trim().replace(/^["']|["']$/g, '');
      let certObj: ServiceAccount | null = null;

      // Check if it's a file path pointing to an existing file
      if ((trimmed.endsWith('.json') || trimmed.startsWith('./') || trimmed.startsWith('/') || trimmed.startsWith('~/')) && !trimmed.startsWith('{')) {
        const filePath = resolveCredentialFilePath(trimmed);
        if (fs.existsSync(filePath)) {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            certObj = parseServiceAccountKey(content);
          } catch (readErr: any) {
            state.initError = `Failed to read file from FIREBASE_SERVICE_ACCOUNT_KEY: ${sanitizeError(readErr)}`;
            console.warn(`[Firebase Admin] Configuration diagnostic: ${state.initError}`);
          }
        }
      }

      if (!certObj) {
        try {
          certObj = parseServiceAccountKey(trimmed);
        } catch (err: any) {
          const keyMsg = `Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY: ${sanitizeError(err)}`;
          state.initError = keyMsg;
          console.warn(`[Firebase Admin] Configuration diagnostic: ${keyMsg}`);
        }
      }

      if (certObj) {
        state.app = initializeApp({
          credential: cert(certObj),
          projectId: certObj.projectId
        });
        state.auth = getAuth(state.app);
        state.isConfigured = true;
        state.credentialSource = 'service_account_key';
        state.projectId = certObj.projectId || null;
        state.initError = null;
        console.log(`[Firebase Admin] Successfully initialized with service account for project: "${state.projectId}".`);
        checkProjectIdMatch(state.projectId);
        return state.app;
      }
    }

    // -------------------------------------------------------------------------
    // Strategy 2: Google Application Credentials (GOOGLE_APPLICATION_CREDENTIALS)
    // Supports:
    // - File path (relative or absolute, surrounding quotes, ~/ expansion)
    // - Inline JSON string or Base64-encoded JSON string
    // -------------------------------------------------------------------------
    const rawGoogleCredsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (rawGoogleCredsPath && typeof rawGoogleCredsPath === 'string' && rawGoogleCredsPath.trim()) {
      const cleanInputPath = rawGoogleCredsPath.trim().replace(/^["']|["']$/g, '');

      // Check if GOOGLE_APPLICATION_CREDENTIALS was passed as inline JSON or Base64 JSON
      let inlineCertObj: ServiceAccount | null = null;
      if (cleanInputPath.startsWith('{') || (!cleanInputPath.includes('/') && !cleanInputPath.includes('\\') && cleanInputPath.length > 100)) {
        try {
          inlineCertObj = parseServiceAccountKey(cleanInputPath);
        } catch (_) {
          // Fall through to treat as file path
        }
      }

      if (inlineCertObj) {
        try {
          state.app = initializeApp({
            credential: cert(inlineCertObj),
            projectId: inlineCertObj.projectId
          });
          state.auth = getAuth(state.app);
          state.isConfigured = true;
          state.credentialSource = 'google_application_credentials';
          state.projectId = inlineCertObj.projectId || null;
          state.initError = null;
          console.log(`[Firebase Admin] Successfully initialized with service account from GOOGLE_APPLICATION_CREDENTIALS (inline JSON) for project: "${state.projectId}".`);
          checkProjectIdMatch(state.projectId);
          return state.app;
        } catch (initErr: any) {
          const initMsg = `Failed to initialize Firebase Admin with inline JSON from GOOGLE_APPLICATION_CREDENTIALS: ${sanitizeError(initErr)}`;
          state.isConfigured = false;
          state.app = null;
          state.auth = null;
          state.credentialSource = 'none';
          state.initError = initMsg;
          console.warn(`[Firebase Admin] Configuration diagnostic: ${initMsg}`);
          return null;
        }
      }

      // Treat as file path
      const resolvedPath = resolveCredentialFilePath(cleanInputPath);

      // Diagnostic check: File Existence
      if (!fs.existsSync(resolvedPath)) {
        const missingMsg = `GOOGLE_APPLICATION_CREDENTIALS file not found: "${cleanInputPath}" (resolved to: "${resolvedPath}"). Please verify that the file exists and the path is correct.`;
        state.isConfigured = false;
        state.app = null;
        state.auth = null;
        state.credentialSource = 'none';
        state.initError = missingMsg;
        console.warn(`[Firebase Admin] Configuration diagnostic: ${missingMsg}`);
        return null;
      }

      // Diagnostic check: Read Permissions
      try {
        fs.accessSync(resolvedPath, fs.constants.R_OK);
      } catch (accessErr: any) {
        const unreadableMsg = `GOOGLE_APPLICATION_CREDENTIALS file is not readable at "${resolvedPath}": ${sanitizeError(accessErr)}. Check file permissions.`;
        state.isConfigured = false;
        state.app = null;
        state.auth = null;
        state.credentialSource = 'none';
        state.initError = unreadableMsg;
        console.warn(`[Firebase Admin] Configuration diagnostic: ${unreadableMsg}`);
        return null;
      }

      // Diagnostic check: File Content
      let fileContent = '';
      try {
        fileContent = fs.readFileSync(resolvedPath, 'utf8');
      } catch (readErr: any) {
        const readMsg = `Failed to read GOOGLE_APPLICATION_CREDENTIALS file at "${resolvedPath}": ${sanitizeError(readErr)}`;
        state.isConfigured = false;
        state.app = null;
        state.auth = null;
        state.credentialSource = 'none';
        state.initError = readMsg;
        console.warn(`[Firebase Admin] Configuration diagnostic: ${readMsg}`);
        return null;
      }

      // Attempt parsing as a Firebase Service Account Key JSON
      let certObj: ServiceAccount | null = null;
      let parseErrDetail: string | null = null;
      try {
        certObj = parseServiceAccountKey(fileContent);
      } catch (pErr: any) {
        parseErrDetail = sanitizeError(pErr);
      }

      if (certObj) {
        try {
          state.app = initializeApp({
            credential: cert(certObj),
            projectId: certObj.projectId
          });
          state.auth = getAuth(state.app);
          state.isConfigured = true;
          state.credentialSource = 'google_application_credentials';
          state.projectId = certObj.projectId || null;
          state.initError = null;
          console.log(`[Firebase Admin] Successfully initialized with service account from "${cleanInputPath}" for project: "${state.projectId}".`);
          checkProjectIdMatch(state.projectId);
          return state.app;
        } catch (initErr: any) {
          const initMsg = `Failed to initialize Firebase Admin with service account key from "${cleanInputPath}": ${sanitizeError(initErr)}`;
          state.isConfigured = false;
          state.app = null;
          state.auth = null;
          state.credentialSource = 'none';
          state.initError = initMsg;
          console.warn(`[Firebase Admin] Configuration diagnostic: ${initMsg}`);
          return null;
        }
      }

      // If not a standard ServiceAccount JSON, attempt initialization via Application Default Credentials
      try {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = resolvedPath;
        const targetProjectId =
          process.env.FIREBASE_PROJECT_ID ||
          process.env.VITE_FIREBASE_PROJECT_ID ||
          process.env.GOOGLE_CLOUD_PROJECT;

        state.app = initializeApp({
          credential: applicationDefault(),
          ...(targetProjectId && targetProjectId !== 'YOUR_FIREBASE_PROJECT_ID' ? { projectId: targetProjectId } : {})
        });
        state.auth = getAuth(state.app);
        state.isConfigured = true;
        state.credentialSource = 'google_application_credentials';
        state.projectId = targetProjectId || null;
        state.initError = null;
        console.log(`[Firebase Admin] Successfully initialized via Application Default Credentials using file "${cleanInputPath}".`);
        checkProjectIdMatch(state.projectId);
        return state.app;
      } catch (adcErr: any) {
        const adcMsg = `GOOGLE_APPLICATION_CREDENTIALS file "${cleanInputPath}" could not be initialized as a service account (${parseErrDetail || 'unrecognized format'}) or ADC: ${sanitizeError(adcErr)}`;
        state.isConfigured = false;
        state.app = null;
        state.auth = null;
        state.credentialSource = 'none';
        state.initError = adcMsg;
        console.warn(`[Firebase Admin] Configuration diagnostic: ${adcMsg}`);
        return null;
      }
    }

    // -------------------------------------------------------------------------
    // Strategy 2b: Discrete Environment Variables (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)
    // -------------------------------------------------------------------------
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
    const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY;
    const discreteProjectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.VITE_FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT;

    if (clientEmail && clientEmail.trim() && privateKeyRaw && privateKeyRaw.trim()) {
      try {
        const privateKey = privateKeyRaw.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
        const projId = discreteProjectId?.trim().replace(/^["']|["']$/g, '') || undefined;
        const certObj: ServiceAccount = {
          projectId: projId,
          clientEmail: clientEmail.trim().replace(/^["']|["']$/g, ''),
          privateKey
        };

        state.app = initializeApp({
          credential: cert(certObj),
          ...(projId && projId !== 'YOUR_FIREBASE_PROJECT_ID' ? { projectId: projId } : {})
        });
        state.auth = getAuth(state.app);
        state.isConfigured = true;
        state.credentialSource = 'service_account_fields';
        state.projectId = projId || null;
        state.initError = null;
        console.log(`[Firebase Admin] Successfully initialized with discrete service account fields for project: "${state.projectId || 'default'}".`);
        checkProjectIdMatch(state.projectId);
        return state.app;
      } catch (discreteErr: any) {
        const discMsg = `Failed to initialize Firebase Admin with discrete credentials (FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY): ${sanitizeError(discreteErr)}`;
        state.initError = discMsg;
        console.warn(`[Firebase Admin] Configuration diagnostic: ${discMsg}`);
      }
    }

    // -------------------------------------------------------------------------
    // Strategy 3: Application Default Credentials via Cloud Environment Project ID
    // -------------------------------------------------------------------------
    const targetProjectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.VITE_FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT;

    if (
      targetProjectId &&
      targetProjectId !== 'YOUR_FIREBASE_PROJECT_ID' &&
      hasUsableApplicationDefaultCredentials()
    ) {
      try {
        state.app = initializeApp({
          credential: applicationDefault(),
          projectId: targetProjectId
        });
        state.auth = getAuth(state.app);
        state.isConfigured = true;
        state.credentialSource = 'application_default';
        state.projectId = targetProjectId;
        state.initError = null;
        console.log(`[Firebase Admin] Initialized with Application Default Credentials for project: "${targetProjectId}".`);
        return state.app;
      } catch (adcErr: any) {
        state.initError = `Application Default Credentials unavailable for project "${targetProjectId}": ${sanitizeError(adcErr)}`;
      }
    }

    // -------------------------------------------------------------------------
    // Fallthrough: Unconfigured State
    // -------------------------------------------------------------------------
    state.isConfigured = false;
    state.app = null;
    state.auth = null;
    state.credentialSource = 'none';
    if (!state.initError) {
      state.initError = 'No Firebase service account credentials found in environment (GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_SERVICE_ACCOUNT_KEY, or FIREBASE_CLIENT_EMAIL/PRIVATE_KEY).';
      console.log('[Firebase Admin] Notice: Firebase Admin SDK is unconfigured. Server-side token verification will reject tokens until configured.');
    } else {
      console.warn(`[Firebase Admin] Notice: Firebase Admin SDK is unconfigured (${state.initError}). Server-side token verification will reject tokens until configured.`);
    }
    return null;
  } catch (err: any) {
    const errorMsg = sanitizeError(err);
    state.isConfigured = false;
    state.app = null;
    state.auth = null;
    state.credentialSource = 'none';
    state.initError = errorMsg;
    console.warn(`[Firebase Admin] Non-fatal initialization warning: ${errorMsg}`);
    return null;
  }
}

/**
 * Returns whether Firebase Admin SDK is initialized and ready to verify tokens.
 * Performs lazy initialization if not yet attempted.
 */
export function isFirebaseAdminConfigured(): boolean {
  if (state.mockVerifier) return true;
  if (!state.isConfigured || !state.auth) {
    initializeFirebaseAdmin();
  }
  return state.isConfigured && Boolean(state.auth);
}

/**
 * Returns the current initialization error, if any.
 */
export function getFirebaseAdminInitError(): string | null {
  return state.initError;
}

/**
 * Returns the active Firebase Admin Auth instance or null if unconfigured.
 */
export function getFirebaseAdminAuth(): Auth | null {
  return state.auth;
}

/**
 * Safe diagnostic summary for debugging Firebase Admin configuration status.
 * Never outputs private keys, tokens, or raw credential strings.
 */
export function getFirebaseAdminDiagnostic(): {
  isConfigured: boolean;
  credentialSource: FirebaseCredentialSource;
  projectId: string | null;
  frontendProjectId: string | null;
  projectIdMatches: boolean | null;
  initError: string | null;
} {
  const frontendProjectId =
    process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || null;
  const configuredProjectId = state.projectId;
  const matches =
    frontendProjectId && configuredProjectId
      ? frontendProjectId === configuredProjectId
      : null;

  return {
    isConfigured: state.isConfigured,
    credentialSource: state.mockVerifier ? 'mock_verifier' : state.credentialSource,
    projectId: state.projectId,
    frontendProjectId,
    projectIdMatches: matches,
    initError: state.initError
  };
}

/**
 * Cryptographically verifies a Firebase Authentication ID token.
 *
 * @param token - Raw JWT ID token string from Bearer Authorization header
 * @param checkRevoked - Whether to verify if the token has been revoked
 * @returns DecodedIdToken containing verified uid, email, claims, and expiration
 */
export async function verifyFirebaseIdToken(
  token: string,
  checkRevoked = false
): Promise<DecodedIdToken> {
  // Test hook: allows isolated unit tests without requiring active GCP network access
  if (state.mockVerifier) {
    return state.mockVerifier(token);
  }

  if (!state.isConfigured || !state.auth) {
    // Attempt lazy initialization in case env vars were set after boot
    initializeFirebaseAdmin();
  }

  if (!state.isConfigured || !state.auth) {
    const err = new Error(
      state.initError || 'Firebase Admin SDK is not configured on this server.'
    );
    (err as any).code = 'auth/service-unconfigured';
    throw err;
  }

  return state.auth.verifyIdToken(token, checkRevoked);
}

/**
 * TEST HOOK: Configures a custom token verifier for automated test suites.
 * Pass null to restore standard Firebase Admin SDK verification.
 */
export function setMockAuthVerifierForTesting(
  verifier: ((token: string) => Promise<DecodedIdToken>) | null
): void {
  state.mockVerifier = verifier;
}

/**
 * TEST HOOK: Resets mock verifier state for clean testing.
 */
export function resetFirebaseAdminForTesting(): void {
  state.mockVerifier = null;
}

/**
 * TEST HOOK: Completely resets Firebase Admin SDK state, including app instance deletion.
 */
export async function fullResetFirebaseAdminForTesting(): Promise<void> {
  state.mockVerifier = null;
  const activeApps = new Set<App>();
  if (state.app) {
    activeApps.add(state.app);
  }
  for (const existingApp of getApps()) {
    if (existingApp) {
      activeApps.add(existingApp);
    }
  }
  for (const appInstance of activeApps) {
    try {
      await deleteApp(appInstance);
    } catch (_) {}
  }
  state.app = null;
  state.auth = null;
  state.isConfigured = false;
  state.credentialSource = 'none';
  state.initError = null;
  state.projectId = null;
}
