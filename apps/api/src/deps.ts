// What the api needs from the world outside its own code, passed to createApp(deps). Production
// builds the Mongo implementations once per process (db/mongoDeps.ts) and the login's settings
// from env (auth/authConfig.ts); tests pass in-memory fakes (fakeDeps.ts), so no test touches the
// network or Atlas.
import type { AttemptStore } from './attempts/attemptStore.ts';
import type { VerifyCredentials } from './auth/credentials.ts';
import type { OrdersRepo } from './orders/ordersRepo.ts';

/** Everything the app talks to outside itself; tests pass fakes (CLAUDE.md: every external call behind an interface). */
export interface AppDeps {
  /** Stored orders (collection `orders`). */
  orders: OrdersRepo;
  /** Attempt counts for login limits and the form's rate limit (ADR-0004). */
  attempts: AttemptStore;
  /** Whether the database answers, for /api/health. */
  db: DbHealth;
  /** The collector's login and session cookie (ADR-0004). */
  auth: AuthDeps;
}

/** Whether the database answers. /api/health uses it, which also opens the connection early (warm-up, ADR-0002). */
export interface DbHealth {
  /** Resolves when the database answers; rejects when it cannot be reached. */
  ping(): Promise<void>;
}

/**
 * What the login routes and the collector guard need (ADR-0004). Production builds it from env
 * (authDepsFromEnv, auth/authConfig.ts); tests use createFakeAuth (fakeDeps.ts).
 */
export interface AuthDeps {
  /** ADR-0004: checks the collector's password. */
  verifyCredentials: VerifyCredentials;
  /** HMAC key of the session cookie (SESSION_SECRET). Replacing it logs out every device. */
  sessionSecret: string;
  /** The cookie's Secure attribute: true everywhere except local development. */
  secureCookie: boolean;
  /** Clock for issuing, expiring and renewing sessions; defaults to the real clock. Tests pass a fake. */
  now?: () => Date;
}
