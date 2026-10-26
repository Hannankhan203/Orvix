import type { Request, Response } from 'express';
import { app } from '../server.ts';

export const maxDuration = 60;

export default function handler(req: Request, res: Response) {
  let subpath = '';
  let queryString = '';

  try {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    subpath = urlObj.searchParams.get('__subpath') || urlObj.searchParams.get('match') || '';
    urlObj.searchParams.delete('__subpath');
    urlObj.searchParams.delete('match');
    queryString = urlObj.search;
  } catch (_) {}

  if (subpath) {
    const cleanSub = subpath.replace(/^\/+/, '');
    req.url = `/api/db/${cleanSub}${queryString}`;
  } else if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
    req.url = `/api/db${queryString}`;
  } else if (!req.url.startsWith('/api/db')) {
    const trimmed = req.url.startsWith('/') ? req.url : `/${req.url}`;
    req.url = `/api/db${trimmed}`;
  }

  return app(req, res);
}

export { app };
