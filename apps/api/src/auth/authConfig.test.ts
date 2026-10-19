// Tests of the login's env settings (authDepsFromEnv): what a good env gives, and that a missing
// or bad variable stops the startup with a message that names it but never repeats its value.
// The env is a plain object built per test; process.env is never read or changed.
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_SECRET_MIN_LENGTH, authDepsFromEnv } from './authConfig.ts';
import { hashPassword } from './passwordHash.ts';

/** A test-only password and secret. */
const PASSWORD = 'four long words for yoel';
const SECRET = 'test-secret-0123456789-abcdefghijklmnop';

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

/** A complete env, with `overrides` on top (`undefined` removes a variable). */
function envWith(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { COLLECTOR_PASSWORD_HASH: passwordHash, SESSION_SECRET: SECRET, ...overrides };
}

/** The message authDepsFromEnv throws for `env`; fails the test if it does not throw. */
function startupError(env: NodeJS.ProcessEnv): string {
  try {
    authDepsFromEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('expected authDepsFromEnv to throw');
}

describe('authDepsFromEnv', () => {
  it('checks the password against COLLECTOR_PASSWORD_HASH', async () => {
    const auth = authDepsFromEnv(envWith());

    expect(await auth.verifyCredentials(PASSWORD)).toEqual({ sub: 'collector' });
    expect(await auth.verifyCredentials('not the password')).toBeNull();
  });

  it('signs sessions with SESSION_SECRET, on the real clock', () => {
    const auth = authDepsFromEnv(envWith());

    expect(auth.sessionSecret).toBe(SECRET);
    expect(auth.now).toBeUndefined();
  });

  it('accepts a SESSION_SECRET of exactly the minimum length', () => {
    const secret = 's'.repeat(SESSION_SECRET_MIN_LENGTH);

    expect(authDepsFromEnv(envWith({ SESSION_SECRET: secret })).sessionSecret).toBe(secret);
  });

  describe('secureCookie', () => {
    it('is false only when NODE_ENV is development (a local run over http://)', () => {
      expect(authDepsFromEnv(envWith({ NODE_ENV: 'development' })).secureCookie).toBe(false);
    });

    it.each([
      ['production', 'production'],
      ['test', 'test'],
      ['a differently written development', 'Development'],
      ['unset', undefined],
    ])('is true when NODE_ENV is %s', (_label, nodeEnv) => {
      expect(authDepsFromEnv(envWith({ NODE_ENV: nodeEnv })).secureCookie).toBe(true);
    });
  });

  describe('refuses to start', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
    ])('when COLLECTOR_PASSWORD_HASH is %s', (_label, value) => {
      const message = startupError(envWith({ COLLECTOR_PASSWORD_HASH: value }));

      expect(message).toMatch(/^COLLECTOR_PASSWORD_HASH is not set/u);
      expect(message).toContain('npm run -s hash-password --workspace apps/api');
      expect(message).not.toContain(SECRET);
    });

    it('when COLLECTOR_PASSWORD_HASH is malformed, without repeating it', () => {
      const malformed = 'scrypt$c2VjcmV0LXNhbHQ$bm90LWEtcmVhbC1oYXNo';

      const message = startupError(envWith({ COLLECTOR_PASSWORD_HASH: malformed }));

      expect(message).toMatch(/^COLLECTOR_PASSWORD_HASH is invalid/u);
      expect(message).not.toContain('c2VjcmV0LXNhbHQ');
      expect(message).not.toContain('bm90LWEtcmVhbC1oYXNo');
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
    ])('when SESSION_SECRET is %s', (_label, value) => {
      const message = startupError(envWith({ SESSION_SECRET: value }));

      expect(message).toMatch(/^SESSION_SECRET is not set/u);
      expect(message).toContain('randomBytes(32)');
      expect(message).not.toContain(passwordHash);
    });

    it('when SESSION_SECRET is shorter than 32 characters, without repeating it', () => {
      const short = 'short-secret-0123456789-abcdefg';
      expect(short).toHaveLength(SESSION_SECRET_MIN_LENGTH - 1);

      const message = startupError(envWith({ SESSION_SECRET: short }));

      expect(message).toMatch(/^SESSION_SECRET is too short/u);
      expect(message).toContain(`${SESSION_SECRET_MIN_LENGTH} characters`);
      expect(message).not.toContain(short);
      expect(message).not.toContain(passwordHash);
    });
  });
});
