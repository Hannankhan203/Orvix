import express from 'express';
import type { Request, Response } from 'express';
import {
  applyCorsMiddleware,
  isServerless,
  getServerProviderConfigStatus
} from '../server/serverConfig.ts';
import { APP_CONFIG } from '../src/config/appConfig.js';

const app = express();
applyCorsMiddleware(app);

app.get(['/api/config', '/config'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    return res.json(getServerProviderConfigStatus(isServerless));
  } catch (err) {
    console.warn('[Vercel Handler] Error resolving provider config status:', err);
    return res.status(200).json({
      geminiConfigured: false,
      groqConfigured: false,
      openrouterConfigured: false,
      cloudflareConfigured: false,
      supabaseConfigured: false,
      webllmSupported: true,
      demoModeEnabled: false,
      whisperConfigured: false,
      whisperProvider: null,
      websocketStreamingSupported: false,
      websocketStreamingEndpoint: null
    });
  }
});

/**
 * Vercel Serverless Function entry point for /api/config.
 * Rewrites the request URL to /api/config so Express route matches correctly,
 * preventing HTTP 500 crashes on Vercel deployments.
 */
export default function handler(req: Request, res: Response) {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (req.url === '/' || !req.url) {
      req.url = '/api/config';
    } else if (req.url.startsWith('/?')) {
      req.url = '/api/config' + req.url.slice(1);
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
      supabaseConfigured: false,
      webllmSupported: true,
      demoModeEnabled: false,
      whisperConfigured: false,
      whisperProvider: null,
      websocketStreamingSupported: false,
      websocketStreamingEndpoint: null
    });
  }
}

export { app, APP_CONFIG };
