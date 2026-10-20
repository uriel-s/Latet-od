// The login's settings from env (ADR-0004): COLLECTOR_PASSWORD_HASH, SESSION_SECRET and NODE_ENV
// become the AuthDeps createApp needs. Both entry points call it once at startup through
// depsFromEnv (envDeps.ts): server.ts, and the Vercel function entry vercelEntry.ts on its first
// request. A missing or bad value stops the startup, so a misconfigured deploy fails at once
// instead of refusing every login.
import type { AuthDeps } from '../deps.ts';
import { createVerifyCredentials } from './credentials.ts';

/**
 * Shortest SESSION_SECRET accepted. The secret is the HMAC key that every session cookie's
 * signature depends on; 32 characters of base64url (the generator below prints 43) leaves no room
 * for guessing it. session.ts does not check it itself, so this is the only guard.
 */
export const SESSION_SECRET_MIN_LENGTH = 32;

/** How to make a SESSION_SECRET, quoted in the error messages. */
const SECRET_RECIPE = `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`;

/**
 * The {@link AuthDeps} described by `env` (normally `process.env`).
 *
 * - `COLLECTOR_PASSWORD_HASH`: the scrypt hash from `npm run hash-password`; parsed now, so a
 *   malformed one fails here.
 * - `SESSION_SECRET`: at least {@link SESSION_SECRET_MIN_LENGTH} characters.
 * - `secureCookie` is true unless `NODE_ENV` is exactly `development`: fail-safe, so a host that
 *   sets nothing still gets a Secure cookie, and only a developer's local .env drops it (plain
 *   http://localhost). Express's own default env is `development` when NODE_ENV is unset, so
 *   setting it locally changes nothing else.
 * - `now` is left out: the real clock.
 *
 * @throws Error when a variable is missing or bad. The message names the variable and how to fix
 *   it, never its value: both are secrets, and the message is printed at startup.
 */
export function authDepsFromEnv(env: NodeJS.ProcessEnv): AuthDeps {
  const passwordHash = env.COLLECTOR_PASSWORD_HASH;
  if (!passwordHash) {
    throw new Error(
      'COLLECTOR_PASSWORD_HASH is not set: generate it with `npm run -s hash-password --workspace apps/api` ' +
        'and put it in apps/api/.env (see .env.example) or in the hosting env.',
    );
  }
  let verifyCredentials: AuthDeps['verifyCredentials'];
  try {
    verifyCredentials = createVerifyCredentials(passwordHash);
  } catch (error) {
    // parsePasswordHash's message describes the shape that is wrong, never the value, and so does
    // the cause (both entry points log only the message anyway, envErrorMessage in envDeps.ts).
    const reason = error instanceof Error ? error.message : 'malformed';
    throw new Error(`COLLECTOR_PASSWORD_HASH is invalid. ${reason}`, { cause: error });
  }

  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(
      `SESSION_SECRET is not set: generate one with ${SECRET_RECIPE} ` +
        'and put it in apps/api/.env (see .env.example) or in the hosting env.',
    );
  }
  if (sessionSecret.length < SESSION_SECRET_MIN_LENGTH) {
    throw new Error(
      `SESSION_SECRET is too short: it needs at least ${SESSION_SECRET_MIN_LENGTH} characters. ` +
        `Generate one with ${SECRET_RECIPE}`,
    );
  }

  return {
    verifyCredentials,
    sessionSecret,
    secureCookie: env.NODE_ENV !== 'development',
  };
}
