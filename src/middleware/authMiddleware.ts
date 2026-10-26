/**
 * Orvix Express Authentication Middleware (Phase 3 Step 1)
 *
 * Provides reusable server-side Firebase Authentication ID token verification
 * for protected Express routes.
 *
 * Middleware Functions:
 * 1. requireAuth: Strictly enforces presence and cryptographic validity of a Firebase ID token.
 *    Rejects missing (401), malformed (401), expired (401), and invalid (401) tokens.
 * 2. optionalAuth: Populates req.user if a valid Bearer token is provided, without blocking unauthenticated requests.
 */

import { Request, Response, NextFunction } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import {
  verifyFirebaseIdToken,
  isFirebaseAdminConfigured
} from '../services/firebaseAdminService.ts';

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  token: DecodedIdToken;
}

// Augment Express Request interface with typed authenticated user properties
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      authenticatedUser?: AuthenticatedUser;
    }
  }
}

/**
 * Extracts and parses Bearer token from the incoming request Authorization header.
 * Returns null if header is missing, or an error descriptor if malformed.
 */
export function extractBearerToken(
  req: Request
): { token?: string; error?: { message: string; code: string } } {
  const rawHeader = req.headers.authorization || (req.headers as any).Authorization;

  if (!rawHeader) {
    return {
      error: {
        message: 'Missing Authorization header. Please provide a Bearer token.',
        code: 'AUTH_TOKEN_MISSING'
      }
    };
  }

  if (typeof rawHeader !== 'string') {
    return {
      error: {
        message: 'Malformed Authorization header. Header value must be a string.',
        code: 'AUTH_TOKEN_MALFORMED'
      }
    };
  }

  const parts = rawHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return {
      error: {
        message: 'Malformed Authorization header. Format must be "Bearer <token>".',
        code: 'AUTH_TOKEN_MALFORMED'
      }
    };
  }

  const token = parts[1].trim();
  if (!token) {
    return {
      error: {
        message: 'Malformed Authorization header. Token value cannot be empty.',
        code: 'AUTH_TOKEN_MALFORMED'
      }
    };
  }

  return { token };
}

/**
 * Express middleware requiring a cryptographically verified Firebase Authentication ID token.
 *
 * Attaches the verified user information to `req.user` and `req.authenticatedUser`.
 * Rejects missing, malformed, expired, revoked, or unverified tokens with HTTP 401.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const extraction = extractBearerToken(req);

  if (extraction.error) {
    res.status(401).json({
      error: `Unauthorized: ${extraction.error.message}`,
      code: extraction.error.code
    });
    return;
  }

  const token = extraction.token!;

  if (!isFirebaseAdminConfigured()) {
    res.status(401).json({
      error: 'Unauthorized: Authentication service is not configured to verify tokens.',
      code: 'AUTH_SERVICE_UNCONFIGURED'
    });
    return;
  }

  try {
    const decoded = await verifyFirebaseIdToken(token, false);

    if (!decoded || !decoded.uid) {
      res.status(401).json({
        error: 'Unauthorized: Decoded token does not contain a valid user ID.',
        code: 'AUTH_TOKEN_INVALID'
      });
      return;
    }

    const authenticatedUser: AuthenticatedUser = {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified,
      name: decoded.name,
      picture: decoded.picture,
      token: decoded
    };

    req.user = authenticatedUser;
    req.authenticatedUser = authenticatedUser;

    next();
  } catch (err: any) {
    const errorCode = String(err?.code || '');
    const errorMessage = String(err?.message || err);

    if (errorCode === 'auth/id-token-expired' || errorMessage.toLowerCase().includes('expired')) {
      res.status(401).json({
        error: 'Unauthorized: Authentication token has expired. Please re-authenticate.',
        code: 'AUTH_TOKEN_EXPIRED'
      });
      return;
    }

    if (errorCode === 'auth/id-token-revoked' || errorMessage.toLowerCase().includes('revoked')) {
      res.status(401).json({
        error: 'Unauthorized: Authentication token has been revoked.',
        code: 'AUTH_TOKEN_REVOKED'
      });
      return;
    }

    if (errorCode === 'auth/service-unconfigured') {
      res.status(401).json({
        error: 'Unauthorized: Authentication service is not configured.',
        code: 'AUTH_SERVICE_UNCONFIGURED'
      });
      return;
    }

    res.status(401).json({
      error: 'Unauthorized: Invalid authentication token.',
      code: 'AUTH_TOKEN_INVALID'
    });
  }
}

/**
 * Express middleware that optionally verifies a Firebase ID token if present.
 * If present and valid, attaches `req.user`. If invalid, returns 401.
 * If no Authorization header is provided, allows request to proceed with `req.user = undefined`.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const rawHeader = req.headers.authorization || (req.headers as any).Authorization;
  if (!rawHeader) {
    return next();
  }
  return requireAuth(req, res, next);
}
