import type { Request, Response } from 'express';
import { app } from '../server.ts';

export const config = {
  api: {
    bodyParser: false
  }
};

export default function handler(req: Request, res: Response) {
  // Normalize req.url so Express router matches correctly regardless of Vercel path rewriting
  const matchedPath = (req.headers['x-matched-path'] as string) || '';
  if (matchedPath.startsWith('/api/upload') || matchedPath.startsWith('/upload')) {
    req.url = matchedPath;
  } else if (req.url === '/' || !req.url) {
    req.url = '/api/upload';
  } else if (!req.url.startsWith('/api/upload') && !req.url.startsWith('/upload')) {
    req.url = '/api/upload' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
}

export { app };
