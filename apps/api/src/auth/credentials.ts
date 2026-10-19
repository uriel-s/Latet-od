// The login's password check (ADR-0004): one collector, one password, its scrypt hash in
// COLLECTOR_PASSWORD_HASH. The login route depends only on the VerifyCredentials function type,
// so a future `users` collection replaces this implementation without touching the route.
import type { SessionUser } from '@bottlerun/shared';
import { parsePasswordHash, verifyPassword } from './passwordHash.ts';

/**
 * Checks a typed password: the logged-in user when it is right, null when it is wrong
 * (ADR-0004's `verifyCredentials(password): Promise<SessionUser | null>`). Rejects only on an
 * unexpected crypto failure, never for a wrong password.
 */
export type VerifyCredentials = (password: string) => Promise<SessionUser | null>;

/**
 * The single-password {@link VerifyCredentials}: a password that matches `passwordHash`
 * (`scrypt$<salt>$<hash>`, from `npm run hash-password`) logs in as the collector.
 *
 * The hash is parsed here, once, not on each login: a malformed COLLECTOR_PASSWORD_HASH throws
 * when the app is built, so a bad deploy fails at startup instead of refusing every login with
 * "wrong password". The thrown message never contains the hash.
 */
export function createVerifyCredentials(passwordHash: string): VerifyCredentials {
  const stored = parsePasswordHash(passwordHash);

  return async (password) => {
    const matches = await verifyPassword(password, stored);
    return matches ? { sub: 'collector' } : null;
  };
}
