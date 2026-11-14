import express from 'express';
import type { Request, Response } from 'express';
import { applyCorsMiddleware } from '../server/serverConfig.ts';
import { registerTranscriptionRoutes } from '../server/transcriptionSubsystem.ts';

const app = express();
applyCorsMiddleware(app);
registerTranscriptionRoutes(app);

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
  } else if (req.url.startsWith('/?')) {
    req.url = '/api/transcribe' + req.url.slice(1);
  } else if (!req.url.startsWith('/api/transcribe') && !req.url.startsWith('/transcribe')) {
    req.url = '/api/transcribe' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return app(req, res);
}

export { app };
