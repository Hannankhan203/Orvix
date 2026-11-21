import express from 'express';
import type { Request, Response } from 'express';
import { applyCorsMiddleware, applyJsonBodyMiddleware } from '../server/serverConfig.ts';
import { applySecurityHeadersMiddleware } from '../server/securityHeaders.ts';
import { registerShareRoutes } from '../server/shareSubsystem.ts';

const app = express();
applySecurityHeadersMiddleware(app);
applyCorsMiddleware(app);
applyJsonBodyMiddleware(app);
registerShareRoutes(app);

export default function handler(req: Request, res: Response) {
  try {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const subpath = urlObj.searchParams.get('__subpath') || urlObj.searchParams.get('match') || '';

    if (subpath) {
      urlObj.searchParams.delete('__subpath');
      urlObj.searchParams.delete('match');
      const cleanSub = subpath.replace(/^\/+/, '');
      const remainingQuery = urlObj.searchParams.toString();
      req.url = '/api/share/' + cleanSub + (remainingQuery ? `?${remainingQuery}` : '');
    } else if (req.url === '/' || !req.url) {
      req.url = '/api/share';
    } else if (req.url.startsWith('/?')) {
      req.url = '/api/share' + req.url.slice(1);
    } else if (!req.url.startsWith('/api/share') && !req.url.startsWith('/share')) {
      req.url = '/api/share' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }
  } catch (_) {
    if (req.url === '/' || !req.url) {
      req.url = '/api/share';
    } else if (req.url.startsWith('/?')) {
      req.url = '/api/share' + req.url.slice(1);
    } else if (!req.url.startsWith('/api/share') && !req.url.startsWith('/share')) {
      req.url = '/api/share' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }
  }
  return app(req, res);
}

export const maxDuration = 60;

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '2mb'
    },
    responseLimit: false
  }
};

export { app };
