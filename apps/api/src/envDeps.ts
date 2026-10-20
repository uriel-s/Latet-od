// The one place that turns env into the api's real AppDeps. Both entry points use it, so they
// cannot drift apart: server.ts (local runs and plain Node hosting) at startup, and the Vercel
// function entry api/index.ts (through vercelHandler.ts) on its first request (ADR-0002). Every
// error it throws names the variable that is wrong and how to fix it, never the value: several
// are secrets (MONGODB_URI holds the database password), and the message is printed or logged.
import { authDepsFromEnv } from './auth/authConfig.ts';
import { createMongoDeps } from './db/mongoDeps.ts';
import type { AppDeps, DbDeps } from './deps.ts';
import { messagingDepsFromEnv } from './messages/messagingConfig.ts';

/**
 * The api's real {@link AppDeps} described by `env` (normally `process.env`).
 *
 * The order is the guarantee: first `MONGODB_URI` must be set, then the login's settings
 * (authDepsFromEnv: COLLECTOR_PASSWORD_HASH, SESSION_SECRET) and the WhatsApp settings
 * (messagingDepsFromEnv: MESSAGE_SENDER, PUBLIC_BASE_URL) are checked, and only then
 * `createDbDeps` runs. So a bad setting stops the startup before any database client exists.
 *
 * There is no fallback to in-memory storage when MONGODB_URI is missing: every order would be
 * lost on the next restart (or, on Vercel, the next cold start), and nobody would notice.
 *
 * @param createDbDeps Builds the database pieces from the URI. The real one,
 *   {@link createMongoDeps}, creates the process's MongoClient (without connecting); tests pass a
 *   fake so no client ever exists.
 * @throws Error when a variable is missing or bad, naming it, never repeating its value.
 */
export function depsFromEnv(
  env: NodeJS.ProcessEnv,
  createDbDeps: (uri: string) => DbDeps = createMongoDeps,
): AppDeps {
  const uri = env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set: it is the MongoDB Atlas connection string, with the database name ' +
        'in its path. Set it in apps/api/.env (see .env.example) or in the hosting env.',
    );
  }
  const auth = authDepsFromEnv(env);
  const messaging = messagingDepsFromEnv(env);
  return { ...createDbDeps(uri), auth, messaging };
}

/**
 * What an entry point prints or logs when {@link depsFromEnv} throws: the error's message only.
 * The messages name the variable that is wrong, never its value, and the stack adds nothing for a
 * configuration mistake. A thrown value that is not an Error gets a fixed message.
 */
export function envErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'api could not start: invalid env';
}
