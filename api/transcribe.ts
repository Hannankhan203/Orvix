import type { Request, Response } from 'express';
import { app } from '../server.ts';

export const maxDuration = 120;

export const config = {
  maxDuration: 120,
  api: {
    bodyParser: false
  }
};

export default function handler(req: Request, res: Response) {
  if (req.url === '/' || !req.url) {
    req.url = '/api/transcribe';
  } else if (!req.url.startsWith('/api/transcribe') && !req.url.startsWith('/transcribe')) {
    req.url = '/api/transcribe' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return app(req, res);
}

export { app };
