import {
  initializeApp,
  cert,
  applicationDefault,
  getApps,
  getApp,
  type App,
  type ServiceAccount
} from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';

let cachedFirestore: Firestore | null = null;
let initializedApp: App | null = null;

export function parseServiceAccountCredential(): ServiceAccount | null {
  // 1. Try FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_CONFIG_ADMIN
  const rawKey = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_CONFIG_ADMIN || '').trim();
  if (rawKey) {
    if (rawKey.startsWith('{') && rawKey.endsWith('}')) {
      try {
        const parsed = JSON.parse(rawKey);
        if (parsed.project_id && (parsed.private_key || parsed.client_email)) {
          return parsed as ServiceAccount;
        }
      } catch (err: any) {
        console.warn('[FirebaseAdmin] Failed to parse JSON from FIREBASE_SERVICE_ACCOUNT_KEY:', err?.message);
      }
    } else {
      try {
        const resolved = path.resolve(rawKey);
        if (fs.existsSync(resolved)) {
          const content = fs.readFileSync(resolved, 'utf8');
          const parsed = JSON.parse(content);
          if (parsed.project_id) {
            return parsed as ServiceAccount;
          }
        }
      } catch (err: any) {
        console.warn('[FirebaseAdmin] Failed to read service account key from file path:', err?.message);
      }
    }
  }

  // 2. Try GOOGLE_APPLICATION_CREDENTIALS
  const gCredPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (gCredPath) {
    if (gCredPath.startsWith('{') && gCredPath.endsWith('}')) {
      try {
        const parsed = JSON.parse(gCredPath);
        if (parsed.project_id) return parsed as ServiceAccount;
      } catch (_) {}
    } else {
      try {
        const resolved = path.resolve(gCredPath);
        if (fs.existsSync(resolved)) {
          const content = fs.readFileSync(resolved, 'utf8');
          const parsed = JSON.parse(content);
          if (parsed.project_id) return parsed as ServiceAccount;
        }
      } catch (err: any) {
        console.warn('[FirebaseAdmin] Failed to read GOOGLE_APPLICATION_CREDENTIALS file:', err?.message);
      }
    }
  }

  return null;
}

export function isFirebaseAdminConfigured(): boolean {
  if (initializedApp && cachedFirestore) {
    return true;
  }
  if (parseServiceAccountCredential() !== null) {
    return true;
  }
  // Check for Google Cloud ambient credentials (K_SERVICE with GCP project)
  if (Boolean(process.env.K_SERVICE && (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT))) {
    return true;
  }
  return false;
}

export function initFirebaseAdmin(): App | null {
  if (initializedApp) {
    return initializedApp;
  }

  const existingApps = getApps();
  if (existingApps.length > 0 && existingApps[0]) {
    initializedApp = existingApps[0];
    return initializedApp;
  }

  const credential = parseServiceAccountCredential();
  const projectId = (
    credential?.projectId ||
    (credential as any)?.project_id ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.VITE_FIREBASE_PROJECT_ID ||
    ''
  ).trim();

  try {
    if (credential) {
      initializedApp = initializeApp({
        credential: cert(credential),
        projectId: projectId || undefined
      });
      return initializedApp;
    }

    // Attempt Application Default Credentials if running in Google Cloud or credential path provided
    if (process.env.K_SERVICE || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializedApp = initializeApp({
        credential: applicationDefault(),
        projectId: projectId || undefined
      });
      return initializedApp;
    }
  } catch (err: any) {
    console.warn('[FirebaseAdmin] Error initializing Firebase Admin App:', err?.message || err);
  }

  return null;
}

export function getAdminFirestore(): Firestore | null {
  if (cachedFirestore) {
    return cachedFirestore;
  }

  const app = initFirebaseAdmin();
  if (app) {
    try {
      cachedFirestore = getFirestore(app);
      return cachedFirestore;
    } catch (err: any) {
      console.warn('[FirebaseAdmin] Error obtaining Firestore instance:', err?.message || err);
    }
  }

  return null;
}

export function _resetFirebaseAdminForTesting(): void {
  cachedFirestore = null;
  if (initializedApp) {
    try {
      (initializedApp as any).delete?.();
    } catch (_) {}
    initializedApp = null;
  }
  const existingApps = getApps();
  for (const a of existingApps) {
    try {
      (a as any)?.delete?.();
    } catch (_) {}
  }
}
