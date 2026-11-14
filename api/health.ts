import express from 'express';
import type { Request, Response } from 'express';
import { applyCorsMiddleware } from '../server/serverConfig.ts';

const app = express();
applyCorsMiddleware(app);

app.get(['/api/health', '/health'], (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

export default function handler(req: Request, res: Response) {
  if (req.url === '/' || !req.url) {
    req.url = '/api/health';
  } else if (req.url.startsWith('/?')) {
    req.url = '/api/health' + req.url.slice(1);
  } else if (!req.url.startsWith('/api/health') && !req.url.startsWith('/health')) {
    req.url = '/api/health' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
}

export { app };
