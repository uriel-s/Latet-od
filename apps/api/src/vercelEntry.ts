// The Vercel function (ADR-0002). vercel.json rewrites `/api/(.*)` to the one function, api/index.js,
// and Express still sees the original path (/api/health, /api/orders, …). The local entry is
// server.ts; both build the same deps with depsFromEnv.
//
// api/index.js is NOT written by hand: `npm run build:api` bundles this file (with the api code and
// packages/shared, which are TypeScript that Vercel's Node builder does not trace) into it, and it is
// committed so Vercel finds the function before any build runs. `checks.sh build` fails when the
// committed bundle is out of date. Only express and mongodb stay external, installed by npm.
//
// Only the default export: Vercel treats named exports called GET, POST, … as web handlers.
import { depsFromEnv } from './envDeps.ts';
import { createVercelHandler } from './vercelHandler.ts';

export default createVercelHandler(() => depsFromEnv(process.env));
