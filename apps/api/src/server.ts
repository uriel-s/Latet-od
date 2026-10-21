// Local entry point: `npm run dev:api` (and plain Node hosting, ADR-0002). Env vars come from
// apps/api/.env (see .env.example). It builds the real dependencies once for the process with
// depsFromEnv (envDeps.ts) and listens. The Vercel function entry, vercelEntry.ts at the repo root,
// builds the same deps through the same function, without listen().
import { createApp } from './app.ts';
import type { AppDeps } from './deps.ts';
import { depsFromEnv, envErrorMessage } from './envDeps.ts';

let deps: AppDeps;
try {
  // Fail fast: a missing MONGODB_URI, or a missing or bad COLLECTOR_PASSWORD_HASH, SESSION_SECRET,
  // MESSAGE_SENDER, PUBLIC_BASE_URL or ROUTE_START, stops the startup before any database client
  // exists.
  deps = depsFromEnv(process.env);
} catch (error) {
  // Only the message: it names the variable that is wrong, never its value (some hold secrets).
  console.error(envErrorMessage(error));
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);

createApp(deps).listen(port, (error) => {
  if (error) {
    // E.g. the port is taken. Startup errors hold no request data.
    console.error(`api could not listen on port ${port}: ${error.message}`);
    process.exit(1);
  }
  console.log(`api listening on http://localhost:${port}`);
});
