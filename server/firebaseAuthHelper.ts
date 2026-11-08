import crypto from 'crypto';
import type express from 'express';
import { isValidPathSegment } from './supabaseStorageService.ts';

/**
 * Public Google certificates endpoint for Firebase Auth ID token verification.
 */
export const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

export interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
  projectId?: string;
  claims: Record<string, any>;
}

export type AuthVerificationResult =
  | { success: true; user: VerifiedFirebaseUser }
  | { success: false; error: string; code: string };

export type AuthRequestResult =
  | { status: 'authenticated'; userId: string; user: VerifiedFirebaseUser }
  | { status: 'guest'; userId: null; user?: undefined }
  | { status: 'invalid'; error: string; code: string; userId?: undefined };

// In-memory cache for Google's public certificates
let cachedCertificates: Record<string, string> | null = null;
let cacheExpiresAtMs = 0;

// Test public keys / certificates registry (for unit tests and deterministic offline verification)
const testPublicKeys = new Map<string, string>();

// Optional test verifier hook
let testCustomVerifier: ((token: string) => Promise<AuthVerificationResult | null>) | null = null;

// Optional test Firebase Project ID hook
let testFirebaseProjectId: string | null = null;

/**
 * Registers an in-memory public key / cert for a specific kid (used in automated test suites).
 */
export function setTestPublicKey(kid: string, publicKeyOrCertPem: string): void {
  testPublicKeys.set(kid, publicKeyOrCertPem);
}

/**
 * Clears registered test public keys.
 */
export function clearTestPublicKeys(): void {
  testPublicKeys.clear();
}

/**
 * Sets a custom token verifier hook for testing purposes.
 */
export function setCustomTokenVerifierForTesting(
  verifier: ((token: string) => Promise<AuthVerificationResult | null>) | null
): void {
  testCustomVerifier = verifier;
}

/**
 * Sets a test Firebase Project ID for testing purposes.
 */
export function setTestFirebaseProjectId(projectId: string | null): void {
  testFirebaseProjectId = projectId;
}

export const setTestFirebaseProjectIdForTesting = setTestFirebaseProjectId;

/**
 * Sets mock certificates in cache with a custom expiration timestamp (for unit testing).
 */
export function setCachedCertificatesForTesting(
  certs: Record<string, string> | null,
  expiresAtMs: number
): void {
  cachedCertificates = certs;
  cacheExpiresAtMs = expiresAtMs;
}

/**
 * Gets the current cached certificates and expiration timestamp (for test assertions).
 */
export function getCachedCertificatesStatusForTesting(): {
  cachedCertificates: Record<string, string> | null;
  cacheExpiresAtMs: number;
} {
  return { cachedCertificates, cacheExpiresAtMs };
}

/**
 * Resets cached certificates and test hooks.
 */
export function resetFirebaseAuthForTesting(): void {
  cachedCertificates = null;
  cacheExpiresAtMs = 0;
  testPublicKeys.clear();
  testCustomVerifier = null;
  testFirebaseProjectId = null;
}

/**
 * Validates whether a given Firebase Project ID is non-empty, well-formed, and not a placeholder.
 */
export function isValidFirebaseProjectId(projectId: unknown): projectId is string {
  if (typeof projectId !== 'string') return false;
  const trimmed = projectId.trim();
  if (!trimmed) return false;
  if (/^(?:undefined|null|none|false|true|todo|changeme|na|n\/a)$/i.test(trimmed)) return false;
  if (/^(?:your|my|replace|insert|placeholder|enter)[-_][a-z0-9_-]+$/i.test(trimmed)) return false;
  if (/^<[^>]+>$/.test(trimmed) || /^x{4,}$/i.test(trimmed)) return false;
  if (/[\s/:?#]/.test(trimmed)) return false;
  return true;
}

/**
 * Resolves the configured Firebase Project ID from test hooks or environment variables.
 */
export function getConfiguredFirebaseProjectId(): string {
  if (testFirebaseProjectId !== null) {
    return testFirebaseProjectId.trim();
  }
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.VITE_FIREBASE_PROJECT_ID ||
    ''
  ).trim();
}

/**
 * Parses the Max-Age directive from a Cache-Control header.
 */
function parseMaxAge(cacheControlHeader: string | null): number {
  if (!cacheControlHeader) return 3600;
  const match = cacheControlHeader.match(/max-age=(\d+)/i);
  if (match && match[1]) {
    const parsed = parseInt(match[1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 3600;
}

/**
 * Fetches and caches Google's public x509 certificates.
 *
 * Security Requirement:
 * Never use expired Google certificate caches after certificate retrieval fails.
 * If the cache is expired and fresh certificates cannot be fetched, fail authentication safely.
 */
export async function getGooglePublicCertificates(): Promise<Record<string, string>> {
  const now = Date.now();
  // Return cached certificates only if the cache has not expired
  if (cachedCertificates && now < cacheExpiresAtMs) {
    return cachedCertificates;
  }

  try {
    const res = await fetch(GOOGLE_CERTS_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!res.ok) {
      throw new Error(`Google certificates endpoint returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as Record<string, string>;
    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
      const maxAgeSec = parseMaxAge(res.headers.get('cache-control'));
      cachedCertificates = data;
      cacheExpiresAtMs = now + maxAgeSec * 1000;
      return cachedCertificates;
    }
    throw new Error('Invalid certificate payload received from Google.');
  } catch (err: any) {
    // SECURITY: NEVER return stale or expired certificates when retrieval fails.
    // Expired signing keys could allow forged or revoked tokens to pass verification.
    cachedCertificates = null;
    cacheExpiresAtMs = 0;
    throw new Error(`Failed to retrieve Google public certificates: ${err?.message || err}`);
  }
}

/**
 * Cryptographically verifies a Firebase Auth ID token.
 *
 * Enforces:
 * 1. RS256 algorithm (rejects "none" or symmetric algorithms).
 * 2. Key identifier (kid) presence and matching public certificate.
 * 3. RSA-SHA256 signature verification over header.payload.
 * 4. Token expiration (exp) and issued-at (iat) time checks with clock skew tolerance.
 * 5. Project ID audience (aud) and issuer (iss) claims validation.
 * 6. Non-empty, safe user subject (sub) claim.
 */
export async function verifyFirebaseIdToken(
  token: string,
  options: {
    expectedProjectId?: string;
    clockSkewSeconds?: number;
  } = {}
): Promise<AuthVerificationResult> {
  if (!token || typeof token !== 'string') {
    return {
      success: false,
      error: 'Token is empty or missing.',
      code: 'TOKEN_MISSING'
    };
  }

  // Allow custom test verifier if active
  if (testCustomVerifier) {
    const testResult = await testCustomVerifier(token);
    if (testResult) return testResult;
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return {
      success: false,
      error: 'Malformed JWT structure: token must contain three period-separated segments.',
      code: 'MALFORMED_TOKEN'
    };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Parse and validate header
  let header: { alg?: string; kid?: string; typ?: string };
  try {
    const headerStr = Buffer.from(headerB64, 'base64url').toString('utf8');
    header = JSON.parse(headerStr);
  } catch (_) {
    return {
      success: false,
      error: 'Failed to decode JWT header.',
      code: 'INVALID_HEADER'
    };
  }

  if (!header || typeof header !== 'object') {
    return {
      success: false,
      error: 'Invalid JWT header format.',
      code: 'INVALID_HEADER'
    };
  }

  // Enforce RS256 algorithm — prevents algorithm-confusion & "none" attacks
  if (header.alg !== 'RS256') {
    return {
      success: false,
      error: `Unsupported or insecure token algorithm: '${header.alg}'. Expected RS256.`,
      code: 'INVALID_ALGORITHM'
    };
  }

  if (!header.kid || typeof header.kid !== 'string' || !header.kid.trim()) {
    return {
      success: false,
      error: 'JWT header is missing key identifier (kid).',
      code: 'MISSING_KID'
    };
  }

  // 2. Parse and validate payload claims
  let payload: Record<string, any>;
  try {
    const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    payload = JSON.parse(payloadStr);
  } catch (_) {
    return {
      success: false,
      error: 'Failed to decode JWT payload.',
      code: 'INVALID_PAYLOAD'
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      success: false,
      error: 'Invalid JWT payload format.',
      code: 'INVALID_PAYLOAD'
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const clockSkew = options.clockSkewSeconds ?? CLOCK_SKEW_TOLERANCE_SECONDS;

  // Validate expiration time
  if (typeof payload.exp !== 'number' || payload.exp + clockSkew < nowSec) {
    return {
      success: false,
      error: 'Firebase ID token has expired.',
      code: 'TOKEN_EXPIRED'
    };
  }

  // Validate issued-at time
  if (typeof payload.iat !== 'number' || payload.iat - clockSkew > nowSec) {
    return {
      success: false,
      error: 'Firebase ID token issued in the future.',
      code: 'TOKEN_ISSUED_FUTURE'
    };
  }

  // Validate user subject (sub) claim
  const uid = payload.sub || payload.user_id;
  if (!uid || typeof uid !== 'string' || !uid.trim()) {
    return {
      success: false,
      error: 'Token payload missing user identifier (sub claim).',
      code: 'MISSING_SUBJECT'
    };
  }

  const cleanUid = uid.trim();
  if (
    !isValidPathSegment(cleanUid) ||
    cleanUid.toLowerCase() === 'guest' ||
    cleanUid.toLowerCase().startsWith('guest-') ||
    cleanUid.toLowerCase().startsWith('local-')
  ) {
    return {
      success: false,
      error: 'User identifier is invalid or unauthorized.',
      code: 'INVALID_USER_ID'
    };
  }

  // 3. Require a valid configured Firebase Project ID. Reject authentication if missing.
  const rawExpectedProject = options.expectedProjectId ?? getConfiguredFirebaseProjectId();
  const expectedProject = typeof rawExpectedProject === 'string' ? rawExpectedProject.trim() : '';

  if (!isValidFirebaseProjectId(expectedProject)) {
    return {
      success: false,
      error: 'Firebase authentication is unavailable: Firebase Project ID is not configured.',
      code: 'MISSING_PROJECT_ID'
    };
  }

  // Always enforce exact aud and iss matches
  if (payload.aud !== expectedProject) {
    return {
      success: false,
      error: `Token audience '${payload.aud}' does not match expected project '${expectedProject}'.`,
      code: 'AUDIENCE_MISMATCH'
    };
  }

  const expectedIssuer = `https://securetoken.google.com/${expectedProject}`;
  if (payload.iss !== expectedIssuer) {
    return {
      success: false,
      error: `Token issuer '${payload.iss}' does not match expected project issuer.`,
      code: 'ISSUER_MISMATCH'
    };
  }

  // 3. Cryptographic signature verification
  let publicKeyOrCert: string | undefined;

  // Check test public keys first (for automated testing suites)
  if (testPublicKeys.has(header.kid)) {
    publicKeyOrCert = testPublicKeys.get(header.kid);
  } else {
    // Retrieve Google's public certificates
    try {
      const certs = await getGooglePublicCertificates();
      publicKeyOrCert = certs[header.kid];
    } catch (certErr: any) {
      return {
        success: false,
        error: `Failed to retrieve public certificates for verification: ${certErr?.message || certErr}`,
        code: 'CERTIFICATE_FETCH_ERROR'
      };
    }
  }

  if (!publicKeyOrCert) {
    return {
      success: false,
      error: `Public key not found for token kid: '${header.kid}'.`,
      code: 'KEY_NOT_FOUND'
    };
  }

  try {
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
    const signatureBuffer = Buffer.from(signatureB64, 'base64url');

    const isValid = crypto.verify('RSA-SHA256', signedData, publicKeyOrCert, signatureBuffer);
    if (!isValid) {
      return {
        success: false,
        error: 'Cryptographic signature verification failed: token signature is forged or invalid.',
        code: 'INVALID_SIGNATURE'
      };
    }
  } catch (verifyErr: any) {
    return {
      success: false,
      error: `Signature verification error: ${verifyErr?.message || 'unknown error'}`,
      code: 'VERIFICATION_ERROR'
    };
  }

  return {
    success: true,
    user: {
      uid: cleanUid,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      projectId: typeof payload.aud === 'string' ? payload.aud : undefined,
      claims: payload
    }
  };
}

/**
 * Extracts the raw Bearer token from the HTTP Authorization header.
 * Returns null if the header is absent or does not use Bearer scheme.
 */
export function extractBearerToken(req: express.Request): string | null {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Authenticates an incoming HTTP request.
 *
 * Rules:
 * - If NO Authorization header is provided: returns status 'guest' (userId: null).
 *   Guest & offline uploads are preserved.
 * - If Authorization header IS provided: verifies Firebase ID token cryptographically.
 *   - If valid: returns status 'authenticated' with verified userId.
 *   - If invalid/forged/expired: returns status 'invalid' with rejection error.
 * - NEVER trusts req.body.userId or x-user-id for authorization!
 */
export async function authenticateRequest(req: express.Request): Promise<AuthRequestResult> {
  const authHeader = req.headers?.authorization;

  // Guest / unauthenticated request (no Authorization header provided)
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.trim()) {
    return {
      status: 'guest',
      userId: null
    };
  }

  const token = extractBearerToken(req);
  if (!token) {
    return {
      status: 'invalid',
      error: 'Malformed Authorization header. Expected format: Bearer <firebase_id_token>.',
      code: 'MALFORMED_AUTH_HEADER'
    };
  }

  const verification = await verifyFirebaseIdToken(token);
  if (!verification.success) {
    return {
      status: 'invalid',
      error: verification.error,
      code: verification.code
    };
  }

  return {
    status: 'authenticated',
    userId: verification.user.uid,
    user: verification.user
  };
}

/**
 * Resolves the authenticated user ID exclusively from the verified Firebase identity.
 * Returns the verified user UID, or null for guests, unauthenticated requests,
 * or failed token verifications.
 *
 * NEVER trusts req.body.userId or x-user-id!
 */
export async function resolveVerifiedUserId(req: express.Request): Promise<string | null> {
  const result = await authenticateRequest(req);
  if (result.status === 'authenticated') {
    return result.userId;
  }
  return null;
}

/**
 * Express middleware for routes requiring verified Firebase authentication.
 */
export async function requireFirebaseAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authResult = await authenticateRequest(req);
  if (authResult.status === 'invalid') {
    return res.status(401).json({
      error: authResult.error,
      code: authResult.code
    });
  }

  if (authResult.status === 'guest') {
    return res.status(401).json({
      error: 'Authentication required: missing Bearer token in Authorization header.',
      code: 'AUTH_REQUIRED'
    });
  }

  (req as any).user = authResult.user;
  next();
}
