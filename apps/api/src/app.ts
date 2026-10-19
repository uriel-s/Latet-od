// The Express app, with no listen() call. Two thin entry points wrap it (ADR-0002):
// src/server.ts for local runs and plain Node hosting, and (later) a Vercel function entry.
import express from 'express';
import type { HealthResponse } from '@bottlerun/shared';

export const app = express();

app.disable('x-powered-by');
app.use(express.json());

app.get('/api/health', (_req, res) => {
  const body: HealthResponse = { ok: true };
  res.json(body);
});
