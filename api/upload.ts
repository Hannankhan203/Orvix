import type { Request, Response } from 'express';
import { app } from '../server.ts';

export const maxDuration = 300;

export const config = {
  maxDuration: 300,
  api: {
    bodyParser: false
  }
};

export default function handler(req: Request, res: Response) {
  // Extract subpath query parameter set by Vercel rewrite rule
  let subpath = '';
  try {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    subpath = urlObj.searchParams.get('__subpath') || urlObj.searchParams.get('match') || '';
  } catch (_) {}

  if (subpath) {
    const cleanSub = subpath.replace(/^\/+/, '');
    req.url = '/api/upload/' + cleanSub;
  } else if (req.url === '/' || !req.url) {
    req.url = '/api/upload';
  } else if (!req.url.startsWith('/api/upload') && !req.url.startsWith('/upload')) {
    req.url = '/api/upload' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return app(req, res);
}

export { app };
