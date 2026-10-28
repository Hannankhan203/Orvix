import type { Request, Response } from 'express';
import { app } from '../server.ts';

export default function handler(req: Request, res: Response) {
  // Ensure no socket or response timeouts cut off streaming
  req.setTimeout?.(0);
  res.setTimeout?.(0);
  if (req.socket) {
    req.socket.setTimeout?.(0);
    req.socket.setNoDelay?.(true);
    req.socket.setKeepAlive?.(true, 5000);
  }
  if (res.socket) {
    res.socket.setTimeout?.(0);
    res.socket.setNoDelay?.(true);
    res.socket.setKeepAlive?.(true, 5000);
  }
  res.setHeader?.('X-Accel-Buffering', 'no');

  if (req.url === '/' || !req.url) {
    req.url = '/api/chat';
  } else if (!req.url.startsWith('/api/chat') && !req.url.startsWith('/chat')) {
    req.url = '/api/chat' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
}

export const maxDuration = 300;

export const config = {
  maxDuration: 300,
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    },
    responseLimit: false
  }
};

export { app };
