// Local entry point: `npm run dev:api` (and plain Node hosting, ADR-0002). Env vars come from
// apps/api/.env (see .env.example). It builds the real dependencies once for the process and
// listens; the Vercel function entry (section 10) will build the same deps without listen().
import { createApp } from './app.ts';
import { authDepsFromEnv } from './auth/authConfig.ts';
import { createMongoDeps } from './db/mongoDeps.ts';
import type { AppDeps } from './deps.ts';
import { messagingDepsFromEnv } from './messages/messagingConfig.ts';

const uri = process.env.MONGODB_URI;
if (!uri) {
  // Fail fast: never fall back to in-memory storage, where every order would be lost on restart.
  console.error(
    'MONGODB_URI is not set: copy apps/api/.env.example to apps/api/.env and fill it in.',
  );
  process.exit(1);
}

let deps: AppDeps;
try {
  // The settings from env first: a missing or bad COLLECTOR_PASSWORD_HASH, SESSION_SECRET,
  // MESSAGE_SENDER or PUBLIC_BASE_URL stops the startup before any database client exists.
  const auth = authDepsFromEnv(process.env);
  const messaging = messagingDepsFromEnv(process.env);
  deps = { ...createMongoDeps(uri), auth, messaging };
} catch (error) {
  // Only the message: these errors name the variable that is wrong, never its value (some hold
  // secrets), and the stack adds nothing for a configuration mistake.
  console.error(error instanceof Error ? error.message : 'api could not start: invalid env');
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
