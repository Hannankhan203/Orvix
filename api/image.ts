import type { Request, Response } from 'express';
import { app } from '../server.ts';

export const maxDuration = 120;

export const config = {
  maxDuration: 120
};

export default function handler(req: Request, res: Response) {
  let subpath = '';
  try {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    subpath = urlObj.searchParams.get('__subpath') || urlObj.searchParams.get('match') || '';
  } catch (_) {}

  if (subpath) {
    const cleanSub = subpath.replace(/^\/+/, '');
    req.url = '/api/image/' + cleanSub;
  } else if (req.url === '/' || !req.url) {
    req.url = '/api/image';
  } else if (!req.url.startsWith('/api/image') && !req.url.startsWith('/image') && !req.url.startsWith('/api/images')) {
    req.url = '/api/image' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return app(req, res);
}

export { app };
