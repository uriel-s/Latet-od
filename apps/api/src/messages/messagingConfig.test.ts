// Tests of the WhatsApp settings from env: MESSAGE_SENDER picks the sender (wa.me by default),
// PUBLIC_BASE_URL must be a bare http(s) origin, and a bad value stops the startup with a message
// that names the variable but does not repeat the value. The env is a plain object per test.
import { describe, expect, it } from 'vitest';
import {
  createMessageSender,
  messagingDepsFromEnv,
  parsePublicBaseUrl,
} from './messagingConfig.ts';
import { WaMeLinkSender } from './waMeLinkSender.ts';

/** The message `action` throws; fails the test if it does not throw an Error. */
function startupError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('expected a startup error');
}

describe('createMessageSender', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['wame', 'wame'],
  ])('uses the wa.me sender when MESSAGE_SENDER is %s', (_label, kind) => {
    expect(createMessageSender(kind)).toBeInstanceOf(WaMeLinkSender);
  });

  it('refuses cloud, which is not built yet', () => {
    const message = startupError(() => createMessageSender('cloud'));

    expect(message).toMatch(/^MESSAGE_SENDER=cloud is not built yet/u);
    expect(message).toContain('ADR-0003');
  });

  it.each(['sms', 'WAME', 'twilio-gateway'])('refuses an unknown sender (%s)', (kind) => {
    const message = startupError(() => createMessageSender(kind));

    expect(message).toMatch(/^MESSAGE_SENDER is not a known sender/u);
    expect(message).toContain('"wame"');
    expect(message).not.toContain(kind);
  });
});

describe('parsePublicBaseUrl', () => {
  it.each([
    ['an https origin', 'https://latet-od.example', 'https://latet-od.example'],
    ['an origin with a trailing slash', 'https://latet-od.example/', 'https://latet-od.example'],
    ['the local Vite dev server', 'http://localhost:5173', 'http://localhost:5173'],
    ['an explicit default port', 'https://latet-od.example:443', 'https://latet-od.example'],
  ])('accepts %s, without a trailing slash', (_label, value, origin) => {
    expect(parsePublicBaseUrl(value)).toBe(origin);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('refuses to start when PUBLIC_BASE_URL is %s', (_label, value) => {
    const message = startupError(() => parsePublicBaseUrl(value));

    expect(message).toMatch(/^PUBLIC_BASE_URL is not set/u);
    expect(message).toContain('http://localhost:5173');
  });

  it.each([
    ['no scheme', 'latet-od.example', /^PUBLIC_BASE_URL is not an absolute URL/u],
    ['a scheme that is not http(s)', 'ftp://x.example', /^PUBLIC_BASE_URL must start with https/u],
    ['a path', 'https://x.example/app', /^PUBLIC_BASE_URL must be the site's origin only/u],
    ['a query', 'https://x.example/?a=1', /^PUBLIC_BASE_URL must be the site's origin only/u],
    ['a fragment', 'https://x.example/#a', /^PUBLIC_BASE_URL must be the site's origin only/u],
    ['a user and password', 'https://u:p@x.example', /^PUBLIC_BASE_URL must not contain a user/u],
  ])('refuses %s, without repeating the value', (_label, value, reason) => {
    const message = startupError(() => parsePublicBaseUrl(value));

    expect(message).toMatch(reason);
    expect(message).toContain('https://<your-domain>');
    expect(message).not.toContain(value);
    expect(message).not.toContain('x.example');
  });
});

describe('messagingDepsFromEnv', () => {
  it('builds the wa.me sender and the links origin from env', () => {
    const messaging = messagingDepsFromEnv({
      MESSAGE_SENDER: 'wame',
      PUBLIC_BASE_URL: 'https://latet-od.example/',
    });

    expect(messaging.sender).toBeInstanceOf(WaMeLinkSender);
    expect(messaging.publicBaseUrl).toBe('https://latet-od.example');
  });

  it('defaults to the wa.me sender when MESSAGE_SENDER is unset', () => {
    const messaging = messagingDepsFromEnv({ PUBLIC_BASE_URL: 'http://localhost:5173' });

    expect(messaging.sender).toBeInstanceOf(WaMeLinkSender);
  });

  it('refuses to start without PUBLIC_BASE_URL', () => {
    expect(startupError(() => messagingDepsFromEnv({ MESSAGE_SENDER: 'wame' }))).toMatch(
      /^PUBLIC_BASE_URL is not set/u,
    );
  });

  it('refuses to start with MESSAGE_SENDER=cloud', () => {
    const env = { MESSAGE_SENDER: 'cloud', PUBLIC_BASE_URL: 'https://latet-od.example' };

    expect(startupError(() => messagingDepsFromEnv(env))).toMatch(/^MESSAGE_SENDER=cloud/u);
  });
});
