// Unit tests for Web Push env configuration (ADR-0013): optional when all three VAPID_* vars are
// unset, fails fast when partially set or malformed, and never repeats secret values in errors.
import { describe, expect, it } from 'vitest';
import { parseVapidSubject, pushDepsFromEnv } from './pushConfig.ts';
import { makeVapidKeys } from './testVapidKeys.ts';
import { WebPushSender } from './webPushSender.ts';

/** Returns the Error message thrown by `action`, or fails the test if it does not throw. */
function startupError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('expected a startup error');
}

describe('parseVapidSubject', () => {
  it.each([
    ['a mailto address', 'mailto:yoel@example.com'],
    ['an https URL', 'https://latet-od.example'],
  ])('accepts %s', (_label, subject) => {
    expect(parseVapidSubject(subject)).toBe(subject);
  });

  it.each([
    ['not a URI', 'yoel-at-example-dot-com', /^VAPID_SUBJECT is not a valid URI/u],
    ['http instead of https', 'http://latet-od.example', /^VAPID_SUBJECT must start with/u],
    ['mailto without domain', 'mailto:yoel', /^VAPID_SUBJECT mailto URI must be a plain email/u],
    ['mailto with query', 'mailto:yoel@example.com?subject=hi', /^VAPID_SUBJECT mailto URI/u],
    [
      'https with credentials',
      'https://user:secret-pass@latet-od.example',
      /^VAPID_SUBJECT must not contain a username or password/u,
    ],
  ])('refuses %s without repeating the value', (_label, badSubject, pattern) => {
    const message = startupError(() => parseVapidSubject(badSubject));

    expect(message).toMatch(pattern);
    expect(message).toContain('VAPID_SUBJECT');
    expect(message).not.toContain(badSubject);
    expect(message).not.toContain('secret-pass');
  });
});

describe('pushDepsFromEnv', () => {
  it.each([
    ['all unset', {}],
    ['all empty strings', { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' }],
  ])('returns null (Web Push disabled) when %s', (_label, env) => {
    expect(pushDepsFromEnv(env)).toBeNull();
  });

  it('builds a WebPushSender and exposes publicKey when all three VAPID_* vars are valid', () => {
    const { publicKey, privateKey } = makeVapidKeys();
    const push = pushDepsFromEnv({
      VAPID_PUBLIC_KEY: publicKey,
      VAPID_PRIVATE_KEY: privateKey,
      VAPID_SUBJECT: 'mailto:yoel@example.com',
    });

    expect(push?.publicKey).toBe(publicKey);
    expect(push?.sender).toBeInstanceOf(WebPushSender);
  });

  it.each([
    [
      'missing VAPID_PRIVATE_KEY and VAPID_SUBJECT',
      { VAPID_PUBLIC_KEY: 'pub-secret-val' },
      ['VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    ],
    [
      'missing VAPID_PUBLIC_KEY',
      { VAPID_PRIVATE_KEY: 'priv-secret-val', VAPID_SUBJECT: 'mailto:yoel@example.com' },
      ['VAPID_PUBLIC_KEY'],
    ],
    [
      'missing VAPID_SUBJECT',
      { VAPID_PUBLIC_KEY: 'pub-secret-val', VAPID_PRIVATE_KEY: 'priv-secret-val' },
      ['VAPID_SUBJECT'],
    ],
  ])(
    'refuses a partial configuration (%s), naming the missing variable(s) without repeating values',
    (_label, env, expectedMissing) => {
      const message = startupError(() => pushDepsFromEnv(env));

      for (const varName of expectedMissing) {
        expect(message).toContain(varName);
      }
      expect(message).not.toContain('pub-secret-val');
      expect(message).not.toContain('priv-secret-val');
    },
  );

  it('refuses an invalid VAPID_PUBLIC_KEY without repeating any env value', () => {
    const { privateKey } = makeVapidKeys();
    const badPublic = 'bad-public-key-secret-value';

    const message = startupError(() =>
      pushDepsFromEnv({
        VAPID_PUBLIC_KEY: badPublic,
        VAPID_PRIVATE_KEY: privateKey,
        VAPID_SUBJECT: 'mailto:yoel@example.com',
      }),
    );

    expect(message).toMatch(/^VAPID_PUBLIC_KEY is invalid/u);
    expect(message).not.toContain(badPublic);
    expect(message).not.toContain(privateKey);
  });

  it('refuses an invalid VAPID_PRIVATE_KEY without repeating any env value', () => {
    const { publicKey } = makeVapidKeys();
    const badPrivate = 'bad-private-key-secret-value';

    const message = startupError(() =>
      pushDepsFromEnv({
        VAPID_PUBLIC_KEY: publicKey,
        VAPID_PRIVATE_KEY: badPrivate,
        VAPID_SUBJECT: 'mailto:yoel@example.com',
      }),
    );

    expect(message).toMatch(/^VAPID_PRIVATE_KEY is invalid/u);
    expect(message).not.toContain(badPrivate);
    expect(message).not.toContain(publicKey);
  });

  it('refuses mismatched VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY without repeating either value', () => {
    const first = makeVapidKeys();
    const second = makeVapidKeys();

    const message = startupError(() =>
      pushDepsFromEnv({
        VAPID_PUBLIC_KEY: first.publicKey,
        VAPID_PRIVATE_KEY: second.privateKey,
        VAPID_SUBJECT: 'mailto:yoel@example.com',
      }),
    );

    expect(message).toMatch(/VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY do not match/u);
    expect(message).not.toContain(first.publicKey);
    expect(message).not.toContain(second.privateKey);
  });
});
