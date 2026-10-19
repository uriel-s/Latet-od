// The Express app, built by createApp(deps), with no listen() call. Two thin entry points wrap it
// (ADR-0002): src/server.ts for local runs and plain Node hosting, and (section 10) a Vercel
// function entry. Both pass the real dependencies (db/mongoDeps.ts); tests pass fakes (fakeDeps.ts).
import express, { type Express } from 'express';
import type { ApiErrorBody, HealthResponse } from '@bottlerun/shared';
import type { AppDeps } from './deps.ts';
import { errorHandler, logError } from './errors.ts';
import { createOrderHandlers } from './orders/createOrderRoute.ts';

/**
 * Largest JSON body the api accepts. An order is a few hundred bytes; the limit leaves room for
 * the longest free-text fields while refusing (413) a body that is junk or an attack.
 */
const JSON_BODY_LIMIT = '10kb';

/**
 * Builds the api's Express app on `deps`. Every route goes through the same body parser and
 * error handler; nothing here keeps state between requests (serverless, ADR-0002).
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  // The api runs behind exactly one proxy: Vercel's edge in production, Vite's dev proxy locally.
  // Trusting one hop makes `req.ip` the client's address, taken from the last entry of
  // X-Forwarded-For (the one that proxy added), which the per-IP rate limits need (POST
  // /api/orders below, and the login in section 5). Trusting only one hop means a client cannot
  // pick its IP by sending its own X-Forwarded-For: the entries it adds come before the proxy's
  // and are ignored.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // The form calls this when it loads (ADR-0002, warm-up): it wakes the function, and the ping
  // opens the database connection, so both are warm by the time the customer submits.
  app.get('/api/health', async (req, res) => {
    // Never cached: a cached "ok" would hide an outage, and would skip the warm-up.
    res.set('Cache-Control', 'no-store');
    let body: HealthResponse;
    try {
      await deps.db.ping();
      body = { ok: true };
    } catch (error) {
      logError(error, req);
      res.status(503);
      body = { ok: false };
    }
    res.json(body);
  });

  // The public booking form (spec §3.1): the per-IP rate limit, then the route (createOrderRoute.ts).
  app.post('/api/orders', ...createOrderHandlers(deps));

  // Any other /api path. Express's default 404 is an HTML page that echoes the path, which for
  // a mistyped customer link holds the token.
  app.use('/api', (_req, res) => {
    const body: ApiErrorBody = { error: 'not_found' };
    res.status(404).json(body);
  });

  app.use(errorHandler);

  return app;
}
