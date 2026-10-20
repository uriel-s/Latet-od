// The Vercel function entry (ADR-0002). vercel.json rewrites `/api/(.*)` to this one function, and
// Express still sees the original path (/api/health, /api/orders, …). The local entry is
// apps/api/src/server.ts; both build the same deps with depsFromEnv.
//
// Vercel turns EVERY .ts/.js file in this folder (not starting with `_`) into a function, so nothing
// else goes here: no tests, no helpers (the handler's tests are in apps/api/src/vercelHandler.test.ts).
// Only the default export: Vercel treats named exports called GET, POST, … as web handlers.
import { depsFromEnv } from '../apps/api/src/envDeps.ts';
import { createVercelHandler } from '../apps/api/src/vercelHandler.ts';

export default createVercelHandler(() => depsFromEnv(process.env));
