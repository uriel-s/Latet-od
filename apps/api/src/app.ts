// The Express app, built by createApp(deps), with no listen() call: the public booking form, the
// customer's own order page (/api/o/:token, reached by its token, no login), the collector's
// login, and Yoel's screens under /api/collector (orders, rounds). Two thin entry points wrap it
// (ADR-0002): src/server.ts for local runs and plain Node hosting, and the Vercel function entry
// vercelEntry.ts (at the repo root, through vercelHandler.ts). Both pass the real dependencies, built
// from env by depsFromEnv (envDeps.ts); tests pass fakes (fakeDeps.ts).
import express, { type Express } from 'express';
import type { ApiErrorBody, HealthResponse } from '@bottlerun/shared';
import { createAuthRouter } from './auth/authRoutes.ts';
import { requireCollector } from './auth/requireCollector.ts';
import type { AppDeps } from './deps.ts';
import { errorHandler, logError } from './errors.ts';
import { createCollectorOrdersRouter } from './orders/collectorOrdersRoutes.ts';
import { createOrderHandlers } from './orders/createOrderRoute.ts';
import { createCustomerOrderRouter } from './orders/customerOrderRoutes.ts';
import { createCollectorRoundsRouter } from './rounds/collectorRoundsRoutes.ts';
import { createCollectorStopActionsRouter } from './rounds/collectorStopActionsRoutes.ts';
import { requireSameOrigin } from './sameOrigin.ts';

/**
 * Largest JSON body the api accepts. An order is a few hundred bytes; the limit leaves room for
 * the longest free-text fields while refusing (413) a body that is junk or an attack.
 */
const JSON_BODY_LIMIT = '10kb';

/**
 * Builds the api's Express app on `deps`. Every route goes through the same Origin check, body
 * parser and error handler; nothing here keeps state between requests (serverless, ADR-0002).
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  // The api runs behind exactly one proxy: Vercel's edge in production, Vite's dev proxy locally.
  // Trusting one hop makes `req.ip` the client's address, taken from the last entry of
  // X-Forwarded-For (the one that proxy added), which the per-IP rate limits need (POST
  // /api/orders and POST /api/auth/login below). Trusting only one hop means a client cannot
  // pick its IP by sending its own X-Forwarded-For: the entries it adds come before the proxy's
  // and are ignored.
  app.set('trust proxy', 1);
  // CSRF (ADR-0004): every request that changes something (POST, PATCH, …) must carry an Origin
  // that matches the host it was sent to, or it gets 403 (sameOrigin.ts). It covers every route
  // (POST /api/orders, /api/auth/*, /api/collector/* and any added later) and comes before the body
  // parser, so a refused request's body is never parsed. The site's own requests always match:
  // on Vercel the function sees the public host the browser used (X-Forwarded-Host, trusted
  // above), and in dev Vite's proxy keeps the browser's Host (localhost:5173), because
  // apps/web/vite.config.ts sets `changeOrigin: false`.
  app.use(requireSameOrigin());
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

  // The customer's own page /o/<token> (spec §3.3): GET the order, POST confirm / decline /
  // cancel, and PATCH "שינוי" (address, quantity, note; never the phone)
  // (orders/customerOrderRoutes.ts). Public, so NOT behind requireCollector: the long random token
  // in the path is the only key, and an unknown or malformed one is a 404. The POSTs and the PATCH
  // still go through the Origin check above. Every answer is `Cache-Control: no-store`.
  app.use('/api/o', createCustomerOrderRouter(deps));

  // The collector's login (ADR-0004): POST /api/auth/login, POST /api/auth/logout and
  // GET /api/auth/me (auth/authRoutes.ts).
  app.use('/api/auth', createAuthRouter(deps));

  // Everything under /api/collector is Yoel's alone: without a valid session cookie it answers 401
  // (auth/requireCollector.ts), and an old session is renewed on the way through. Every collector
  // route is mounted under /api/collector, AFTER this line, and is therefore protected. With a
  // valid cookie, a path no route serves falls through to the 404 below.
  app.use('/api/collector', requireCollector(deps.auth));

  // The "הזמנות" screen (spec §3.5): list the waiting orders by region, get, edit, cancel and add
  // an order, and mark an order's WhatsApp "שלח" link as opened (orders/collectorOrdersRoutes.ts).
  app.use('/api/collector/orders', createCollectorOrdersRouter(deps));

  // The round screens (spec §3.5 "תכנון סבב", §3.6): plan a round and send its confirmation
  // requests, list the open rounds, one round, "אישר בטלפון", "סגור אישורים ובנה מסלול", and
  // moving a stop of the route up or down (rounds/collectorRoundsRoutes.ts).
  app.use('/api/collector/rounds', createCollectorRoundsRouter(deps));
  // The stop actions on a routed round's route, on the same path: "אספתי"
  // (rounds/collectorStopActionsRoutes.ts). Their paths never overlap the router above.
  app.use('/api/collector/rounds', createCollectorStopActionsRouter(deps));

  // Any other /api path. Express's default 404 is an HTML page that echoes the path, which for
  // a mistyped customer link holds the token.
  app.use('/api', (_req, res) => {
    const body: ApiErrorBody = { error: 'not_found' };
    res.status(404).json(body);
  });

  app.use(errorHandler);

  return app;
}
