import type { Request, Response } from 'express';
import { app } from '../server.ts';
import { APP_CONFIG } from '../src/config/appConfig.js';

/**
 * Vercel Serverless Function entry point for /api/config.
 * Rewrites the request URL to /api/config so Express route matches correctly,
 * preventing HTTP 500 crashes on Vercel deployments.
 */
export default function handler(req: Request, res: Response) {
  try {
    if (req.url === '/' || !req.url) {
      req.url = '/api/config';
    } else if (!req.url.startsWith('/api/config') && !req.url.startsWith('/config')) {
      req.url = '/api/config' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }
    return app(req, res);
  } catch (err) {
    console.warn('[Vercel Handler] Error handling /api/config request:', err);
    return res.status(200).json({
      geminiConfigured: false,
      groqConfigured: false,
      openrouterConfigured: false,
      cloudflareConfigured: false,
      webllmSupported: true,
      demoModeEnabled: false,
      whisperConfigured: false,
      whisperProvider: null
    });
  }
}

export { app, APP_CONFIG };
