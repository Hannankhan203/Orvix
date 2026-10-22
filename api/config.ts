import type { Request, Response } from 'express';
import { app } from '../server.ts';

export default function handler(req: Request, res: Response) {
  if (req.url === '/' || !req.url) {
    req.url = '/api/config';
  } else if (!req.url.startsWith('/api/config') && !req.url.startsWith('/config')) {
    req.url = '/api/config' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
}

export { app };
