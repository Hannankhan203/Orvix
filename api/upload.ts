import type { Request, Response } from 'express';
import { app } from '../server.ts';

export const config = {
  api: {
    bodyParser: false
  }
};

export default function handler(req: Request, res: Response) {
  return app(req, res);
}

export { app };
