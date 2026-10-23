import type { Request, Response } from 'express';
import { app } from '../server.ts';

export default function handler(req: Request, res: Response) {
  if (req.url === '/' || !req.url) {
    req.url = '/api/chat';
  } else if (!req.url.startsWith('/api/chat') && !req.url.startsWith('/chat')) {
    req.url = '/api/chat' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

export { app };
