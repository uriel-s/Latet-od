// Tests of depsFromEnv, the one env → AppDeps path of both entry points: what a complete env
// gives, and that a missing or bad variable stops the startup before any database client exists,
// with a message that names the variable but never repeats a value. The database factory is a
// fake, so no MongoClient is ever created; the env is a plain object, process.env is never read.
import { straightLineDistance } from '@bottlerun/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from './auth/passwordHash.ts';
import type { DbDeps } from './deps.ts';
import { depsFromEnv, envErrorMessage } from './envDeps.ts';
import { createFakeDeps } from './fakeDeps.ts';
import { WaMeLinkSender } from './messages/waMeLinkSender.ts';

/** Test-only values. The URI's password is what must never reach an error message. */
const URI_PASSWORD = 'db-password-never-logged';
const URI = `mongodb+srv://bottlerun:${URI_PASSWORD}@cluster0.example.mongodb.net/bottlerun`;
const PASSWORD = 'four long words for yoel';
const SECRET = 'test-secret-0123456789-abcdefghijklmnop';
const PUBLIC_BASE_URL = 'https://latet-od.test';
/** A made-up round-number point near the drop-off, nobody's home. */
const ROUTE_START = '31.7,35.0';

let passwordHash: string;

beforeAll(async () => {
  // A real scrypt hash of a test password, made the way `npm run hash-password` makes one.
  passwordHash = await hashPassword(PASSWORD);
});

/** A complete env, with `overrides` on top (`undefined` removes a variable). */
function envWith(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MONGODB_URI: URI,
    COLLECTOR_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: SECRET,
    PUBLIC_BASE_URL,
    MESSAGE_SENDER: 'wame',
    ROUTE_START,
    ...overrides,
  };
}

/** In-memory database pieces, taken from createFakeDeps: what a fake createDbDeps returns. */
function fakeDbDeps(): DbDeps {
  const { orders, rounds, attempts, db } = createFakeDeps();
  return { orders, rounds, attempts, db };
}

/** A fake database factory that records the URI it was given, never creating a client. */
function fakeCreateDbDeps(dbDeps: DbDeps = fakeDbDeps()) {
  return vi.fn<(uri: string) => DbDeps>(() => dbDeps);
}

/** The message depsFromEnv throws for `env`; fails the test if it does not throw. */
function startupError(env: NodeJS.ProcessEnv, createDbDeps = fakeCreateDbDeps()): string {
  try {
    depsFromEnv(env, createDbDeps);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('expected depsFromEnv to throw');
}

describe('depsFromEnv', () => {
  it('builds every dependency from a complete env', async () => {
    const dbDeps = fakeDbDeps();
    const createDbDeps = fakeCreateDbDeps(dbDeps);

    const deps = depsFromEnv(envWith(), createDbDeps);

    expect(createDbDeps).toHaveBeenCalledTimes(1);
    expect(createDbDeps).toHaveBeenCalledWith(URI);
    expect(deps.orders).toBe(dbDeps.orders);
    expect(deps.rounds).toBe(dbDeps.rounds);
    expect(deps.attempts).toBe(dbDeps.attempts);
    expect(deps.db).toBe(dbDeps.db);
    expect(deps.auth.sessionSecret).toBe(SECRET);
    expect(await deps.auth.verifyCredentials(PASSWORD)).toEqual({ sub: 'collector' });
    expect(deps.messaging.sender).toBeInstanceOf(WaMeLinkSender);
    expect(deps.messaging.publicBaseUrl).toBe(PUBLIC_BASE_URL);
    expect(deps.route.start).toEqual({ lat: 31.7, lng: 35 });
    expect(deps.route.distance).toBe(straightLineDistance);
  });

  describe('refuses to start', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
    ])('when MONGODB_URI is %s, without creating the database deps', (_label, value) => {
      const createDbDeps = fakeCreateDbDeps();

      const message = startupError(envWith({ MONGODB_URI: value }), createDbDeps);

      expect(message).toMatch(/^MONGODB_URI is not set/u);
      expect(message).toContain('apps/api/.env (see .env.example) or in the hosting env');
      expect(createDbDeps).not.toHaveBeenCalled();
    });

    it('when MONGODB_URI is missing, before checking the other variables', () => {
      // Everything else is missing too: the first message is the database's.
      const message = startupError({});

      expect(message).toMatch(/^MONGODB_URI is not set/u);
    });

    // Each one is checked before the database deps exist: a bad setting never leaves a client behind.
    it.each([
      ['SESSION_SECRET is missing', { SESSION_SECRET: undefined }, /^SESSION_SECRET is not set/u],
      ['SESSION_SECRET is too short', { SESSION_SECRET: 'short' }, /^SESSION_SECRET is too short/u],
      [
        'COLLECTOR_PASSWORD_HASH is missing',
        { COLLECTOR_PASSWORD_HASH: undefined },
        /^COLLECTOR_PASSWORD_HASH is not set/u,
      ],
      [
        'COLLECTOR_PASSWORD_HASH is malformed',
        { COLLECTOR_PASSWORD_HASH: 'scrypt$not$valid' },
        /^COLLECTOR_PASSWORD_HASH is invalid/u,
      ],
      [
        'PUBLIC_BASE_URL is missing',
        { PUBLIC_BASE_URL: undefined },
        /^PUBLIC_BASE_URL is not set/u,
      ],
      ['MESSAGE_SENDER is unknown', { MESSAGE_SENDER: 'sms' }, /^MESSAGE_SENDER is not a known/u],
      ['ROUTE_START is missing', { ROUTE_START: undefined }, /^ROUTE_START is not set/u],
      ['ROUTE_START is malformed', { ROUTE_START: '31.7;35.0' }, /^ROUTE_START is not two/u],
      ['ROUTE_START is swapped', { ROUTE_START: '35.0,31.7' }, /^ROUTE_START is more than/u],
    ])('when %s, without creating the database deps', (_label, overrides, expected) => {
      const createDbDeps = fakeCreateDbDeps();

      const message = startupError(envWith(overrides), createDbDeps);

      expect(message).toMatch(expected);
      expect(createDbDeps).not.toHaveBeenCalled();
    });
  });

  it('passes on an error from the database deps, after every setting was checked', () => {
    const createDbDeps = vi.fn<(uri: string) => DbDeps>(() => {
      throw new Error('MONGODB_URI must name the database');
    });

    expect(() => depsFromEnv(envWith(), createDbDeps)).toThrow(
      'MONGODB_URI must name the database',
    );
    expect(createDbDeps).toHaveBeenCalledTimes(1);
  });

  it('never repeats a value from env in its error messages', () => {
    const messages = [
      startupError(envWith({ MONGODB_URI: '' })),
      startupError(envWith({ SESSION_SECRET: undefined })),
      startupError(envWith({ SESSION_SECRET: 'short' })),
      startupError(envWith({ COLLECTOR_PASSWORD_HASH: undefined })),
      startupError(envWith({ PUBLIC_BASE_URL: undefined })),
      startupError(envWith({ ROUTE_START: undefined })),
      startupError(envWith({ ROUTE_START: '31.7;35.0' })),
      startupError(envWith({ ROUTE_START: '35.0,31.7' })),
    ];

    for (const message of messages) {
      expect(message).not.toContain(URI_PASSWORD);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(passwordHash);
      // ROUTE_START is Yoel's home: neither the valid one nor a bad one is ever repeated.
      expect(message).not.toContain(ROUTE_START);
      expect(message).not.toContain('31.7');
      expect(message).not.toContain('35.0');
    }
  });
});

describe('envErrorMessage', () => {
  it('is the message of an Error, nothing more', () => {
    const error = new Error('SESSION_SECRET is not set');

    expect(envErrorMessage(error)).toBe('SESSION_SECRET is not set');
  });

  it('is a fixed message for a thrown value that is not an Error', () => {
    expect(envErrorMessage('something')).toBe('api could not start: invalid env');
  });
});
