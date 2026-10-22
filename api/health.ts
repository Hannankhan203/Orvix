import type { Request, Response } from 'express';
import { app } from '../server.ts';

export default function handler(req: Request, res: Response) {
  if (req.url === '/' || !req.url) {
    req.url = '/api/health';
  } else if (!req.url.startsWith('/api/health') && !req.url.startsWith('/health')) {
    req.url = '/api/health' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
}

export { app };
