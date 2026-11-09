import type { Request, Response } from 'express';
import { app } from '../server.ts';

export const maxDuration = 120;

export const config = {
  maxDuration: 120
};

export default function handler(req: Request, res: Response) {
  if (req.url === '/' || !req.url) {
    req.url = '/api/generate-image';
  } else if (!req.url.startsWith('/api/generate-image') && !req.url.startsWith('/generate-image')) {
    req.url = '/api/generate-image' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return app(req, res);
}

export { app };
