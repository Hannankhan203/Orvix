import express from 'express';
import type { Request, Response } from 'express';
import { applyCorsMiddleware, applyJsonBodyMiddleware } from '../server/serverConfig.ts';
import { registerUploadRoutes } from '../server/uploadSubsystem.ts';

const app = express();
applyCorsMiddleware(app);
applyJsonBodyMiddleware(app);
registerUploadRoutes(app);

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'API route not found',
    code: 404,
    status: 'NOT_FOUND'
  });
});

export const maxDuration = 300;

export const config = {
  maxDuration: 300,
  api: {
    bodyParser: false
  }
};

export default function handler(req: Request, res: Response) {
  // Extract subpath query parameter set by Vercel rewrite rule while preserving remaining query params
  try {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const subpath = urlObj.searchParams.get('__subpath') || urlObj.searchParams.get('match') || '';

    if (subpath) {
      urlObj.searchParams.delete('__subpath');
      urlObj.searchParams.delete('match');
      const cleanSub = subpath.replace(/^\/+/, '');
      const remainingQuery = urlObj.searchParams.toString();
      req.url = '/api/upload/' + cleanSub + (remainingQuery ? `?${remainingQuery}` : '');
    } else if (req.url === '/' || !req.url) {
      req.url = '/api/upload';
    } else if (req.url.startsWith('/?')) {
      req.url = '/api/upload' + req.url.slice(1);
    } else if (!req.url.startsWith('/api/upload') && !req.url.startsWith('/upload')) {
      req.url = '/api/upload' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }
  } catch (_) {
    if (req.url === '/' || !req.url) {
      req.url = '/api/upload';
    } else if (req.url.startsWith('/?')) {
      req.url = '/api/upload' + req.url.slice(1);
    } else if (!req.url.startsWith('/api/upload') && !req.url.startsWith('/upload')) {
      req.url = '/api/upload' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }
  }

  return app(req, res);
}

export { app };
