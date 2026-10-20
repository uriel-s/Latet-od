// Acceptance tests of /api/auth/* (ADR-0004) through supertest against createApp(fakes): no
// listen(), no port, no database. Each test keeps the attempt store and the clock it passes in, to
// see what the login counted and to move past a window without waiting. Every POST is sent from
// the site's own origin (SAME_ORIGIN_HEADERS) except in the Origin check's own tests. The guard's
// own cases (expired, forged, renewal) are in requireCollector.test.ts.
import type { Express } from 'express';
import request from 'supertest';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import { LOGIN_MESSAGES, LOGIN_PASSWORD_MAX_LENGTH } from '@bottlerun/shared';
import { createApp } from '../app.ts';
import type { AttemptStore } from '../attempts/attemptStore.ts';
import { InMemoryAttemptStore } from '../attempts/inMemoryAttemptStore.ts';
import type { AuthDeps } from '../deps.ts';
import { FAKE_COLLECTOR_PASSWORD, createFakeAuth, createFakeDeps } from '../fakeDeps.ts';
import { SAME_ORIGIN_HEADERS, TEST_HOST } from '../testRequest.ts';
import { createVerifyCredentials, type VerifyCredentials } from './credentials.ts';
import { LOGIN_GLOBAL_KEY, LOGIN_LIMITS, loginIpKey } from './loginLimits.ts';
import { hashPassword } from './passwordHash.ts';
import { verifySession } from './session.ts';
import {
  epochSeconds,
  loggedInCookie,
  sessionCookieHeader,
  setCookieAttributes,
  setCookieLine,
  setCookieValue,
} from './testSession.ts';

const START = new Date('2026-10-20T09:00:00.000Z');
const MINUTE_MS = 60 * 1000;

/** A wrong guess, distinctive so "the log does not contain it" cannot pass by accident. */
const WRONG_PASSWORD = 'a wrong guess that is distinctive';

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';

/** The origin of a page on another site. */
const FOREIGN_ORIGIN = 'https://evil.example';

let clock: Date;
let attempts: InMemoryAttemptStore;
let verifyCredentials: Mock<VerifyCredentials>;
let auth: AuthDeps;
let app: Express;
let consoleSpies: MockInstance<typeof console.error>[];

beforeEach(() => {
  clock = START;
  attempts = new InMemoryAttemptStore({ now: () => clock });
  // The fake verifier, wrapped so a test can see whether the password was checked at all.
  verifyCredentials = vi.fn(createFakeAuth().verifyCredentials);
  auth = createFakeAuth({ verifyCredentials, now: () => clock });
  app = createApp(createFakeDeps({ attempts, auth }));
  consoleSpies = (['error', 'warn', 'log', 'info'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Moves the fake clock forward by `ms`. */
function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

/**
 * POSTs a login with `password` from the site's own origin, as if the proxy had seen it come from
 * `ip`.
 */
function login(password: unknown, ip = IP, target: Express = app): request.Test {
  return request(target)
    .post('/api/auth/login')
    .set(SAME_ORIGIN_HEADERS)
    .set('X-Forwarded-For', ip)
    .send({ password });
}

/** Failed logins counted for `ip`, and for everyone together. */
async function failuresCounted(ip = IP): Promise<{ ip: number; all: number }> {
  return {
    ip: await attempts.count(loginIpKey(ip), LOGIN_LIMITS.perIp.windowMs),
    all: await attempts.count(LOGIN_GLOBAL_KEY, LOGIN_LIMITS.global.windowMs),
  };
}

/** Sends `count` wrong passwords from `ip`, expecting each to be a plain 401. */
async function failLogins(count: number, ip = IP): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    expect((await login(WRONG_PASSWORD, ip)).status).toBe(401);
  }
}

/** Expects the login's 429: the body with its Hebrew message, never cached, and no cookie. */
function expectRateLimited(res: request.Response): void {
  expect(res.status).toBe(429);
  expect(res.body).toStrictEqual({ error: 'rate_limited', message: LOGIN_MESSAGES.rateLimited });
  expect(res.headers['cache-control']).toBe('no-store');
  expect(setCookieLine(res)).toBeUndefined();
}

describe('POST /api/auth/login', () => {
  it('logs in with the right password: 200, the user, and the session cookie', async () => {
    const res = await login(FAKE_COLLECTOR_PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ user: { sub: 'collector' } });
    expect(res.headers['cache-control']).toBe('no-store');

    const line = setCookieLine(res);
    expect(line).toMatch(/^session=[\w-]+\.[\w-]+;/u);
    expect(setCookieAttributes(line ?? '')).toEqual(
      expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=7776000']),
    );
    // A session issued now, signed with the app's secret.
    const payload = verifySession(setCookieValue(line ?? ''), auth.sessionSecret, clock);
    expect(payload?.iat).toBe(epochSeconds(clock));
  });

  it('sets a cookie that opens GET /api/auth/me', async () => {
    const line = setCookieLine(await login(FAKE_COLLECTOR_PASSWORD));

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', sessionCookieHeader(setCookieValue(line ?? '')));

    expect(me.status).toBe(200);
    expect(me.body).toStrictEqual({ user: { sub: 'collector' } });
  });

  it('sets the cookie without Secure when secureCookie is false (local development)', async () => {
    const devApp = createApp(createFakeDeps({ auth: createFakeAuth({ secureCookie: false }) }));

    const res = await login(FAKE_COLLECTOR_PASSWORD, IP, devApp);

    expect(res.status).toBe(200);
    const attributes = setCookieAttributes(setCookieLine(res) ?? '');
    expect(attributes).not.toContain('Secure');
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']));
  });

  it('answers a wrong password with 401 and its message, sets no cookie, and counts it', async () => {
    const res = await login(WRONG_PASSWORD);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({
      error: 'invalid_credentials',
      message: LOGIN_MESSAGES.wrongPassword,
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(setCookieLine(res)).toBeUndefined();
    expect(await failuresCounted()).toEqual({ ip: 1, all: 1 });
  });

  it.each([
    ['no password field', {}],
    ['an empty password', { password: '' }],
    ['a password that is not a string', { password: 12345678 }],
    ['a password over the length cap', { password: 'x'.repeat(LOGIN_PASSWORD_MAX_LENGTH + 1) }],
    ['a body that is not an object', [FAKE_COLLECTOR_PASSWORD]],
  ])('answers 400 to %s, without checking or counting it', async (_label, body) => {
    const res = await request(app)
      .post('/api/auth/login')
      .set(SAME_ORIGIN_HEADERS)
      .set('X-Forwarded-For', IP)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_login_request' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(await failuresCounted()).toEqual({ ip: 0, all: 0 });
  });

  it('answers 400 to a request with no body at all', async () => {
    const res = await request(app).post('/api/auth/login').set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_login_request' });
  });

  describe('with the real scrypt check (createVerifyCredentials)', () => {
    /** A test-only password, with spaces inside, as a sentence password has. */
    const REAL_PASSWORD = 'four long words for yoel';
    let realApp: Express;

    beforeAll(async () => {
      // Hashed once: scrypt takes tens of milliseconds by design.
      const passwordHash = await hashPassword(REAL_PASSWORD);
      realApp = createApp(
        createFakeDeps({
          auth: createFakeAuth({ verifyCredentials: createVerifyCredentials(passwordHash) }),
        }),
      );
    });

    it('logs in with the password the hash was made from', async () => {
      const res = await login(REAL_PASSWORD, IP, realApp);

      expect(res.status).toBe(200);
      expect(setCookieLine(res)).toBeDefined();
    });

    it('refuses any other password', async () => {
      expect((await login('four long words for joel', IP, realApp)).status).toBe(401);
    });

    it('does not trim the password: spaces around it make it another password', async () => {
      expect((await login(` ${REAL_PASSWORD} `, IP, realApp)).status).toBe(401);
    });
  });
});

describe('POST /api/auth/login: failed-login limits (ADR-0004)', () => {
  it('answers 429 to the 6th attempt after 5 failures from one IP, even with the right password, without checking it', async () => {
    await failLogins(5);
    verifyCredentials.mockClear();

    expectRateLimited(await login(FAKE_COLLECTOR_PASSWORD));
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it('does not count the blocked attempts themselves', async () => {
    await failLogins(5);

    await login(WRONG_PASSWORD);
    await login(WRONG_PASSWORD);

    expect(await failuresCounted()).toEqual({ ip: 5, all: 5 });
  });

  it('still lets another IP log in', async () => {
    await failLogins(5);

    const res = await login(FAKE_COLLECTOR_PASSWORD, OTHER_IP);

    expect(res.status).toBe(200);
    expect(setCookieLine(res)).toBeDefined();
  });

  it('lets the IP try again once 15 minutes have passed', async () => {
    await failLogins(5);

    advance(15 * MINUTE_MS - 1);
    expectRateLimited(await login(FAKE_COLLECTOR_PASSWORD));

    advance(1);
    expect((await login(FAKE_COLLECTOR_PASSWORD)).status).toBe(200);
  });

  it("resets the IP's failures on success, so it gets 5 more before the limit", async () => {
    await failLogins(4);
    expect((await login(FAKE_COLLECTOR_PASSWORD)).status).toBe(200);
    expect((await failuresCounted()).ip).toBe(0);

    await failLogins(5);

    expectRateLimited(await login(FAKE_COLLECTOR_PASSWORD));
  });

  it('keeps the global count on success', async () => {
    await failLogins(4);

    await login(FAKE_COLLECTOR_PASSWORD);

    expect(await failuresCounted()).toEqual({ ip: 0, all: 4 });
  });

  it('answers 429 to everyone after 30 failures from different IPs within an hour', async () => {
    for (let i = 0; i < LOGIN_LIMITS.global.max; i += 1) await failLogins(1, `10.0.0.${i}`);
    verifyCredentials.mockClear();

    expectRateLimited(await login(FAKE_COLLECTOR_PASSWORD, '10.0.1.1'));
    expect(verifyCredentials).not.toHaveBeenCalled();

    advance(60 * MINUTE_MS);
    expect((await login(FAKE_COLLECTOR_PASSWORD, '10.0.1.1')).status).toBe(200);
  });

  it('does not count invalid requests: they are no guess at the password', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await login('')).status).toBe(400);
    }

    expect((await login(FAKE_COLLECTOR_PASSWORD)).status).toBe(200);
  });

  it('fails closed with 500 when the attempt store is down, without checking the password', async () => {
    const outage = new Error('connection refused');
    const down: AttemptStore = {
      hit: () => Promise.reject(outage),
      count: () => Promise.reject(outage),
      reset: () => Promise.reject(outage),
    };
    const target = createApp(createFakeDeps({ attempts: down, auth }));

    const res = await login(FAKE_COLLECTOR_PASSWORD, IP, target);

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: 'internal' });
    expect(setCookieLine(res)).toBeUndefined();
    expect(verifyCredentials).not.toHaveBeenCalled();
  });
});

describe('the Origin check on /api/auth (CSRF)', () => {
  it('refuses a login from another site with 403, even with the right password, counting nothing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Host', TEST_HOST)
      .set('Origin', FOREIGN_ORIGIN)
      .set('X-Forwarded-For', IP)
      .send({ password: FAKE_COLLECTOR_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(setCookieLine(res)).toBeUndefined();
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it('refuses a wrong password from another site with 403, and does not count it', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Host', TEST_HOST)
      .set('Origin', FOREIGN_ORIGIN)
      .set('X-Forwarded-For', IP)
      .send({ password: WRONG_PASSWORD });

    expect(res.status).toBe(403);
    expect(await failuresCounted()).toEqual({ ip: 0, all: 0 });
  });

  it('refuses a logout from another site with 403, leaving the cookie alone', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Host', TEST_HOST)
      .set('Origin', FOREIGN_ORIGIN)
      .set('Cookie', loggedInCookie(auth, clock));

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(setCookieLine(res)).toBeUndefined();
  });
});

describe('POST /api/auth/logout', () => {
  /** Expects the logout's answer: 204, nothing cached, and a Set-Cookie that deletes `session`. */
  function expectLoggedOut(res: request.Response): void {
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    const line = setCookieLine(res) ?? '';
    expect(setCookieValue(line)).toBe('');
    // Expired in 1970, with the attributes it was set with, so the browser replaces it.
    expect(setCookieAttributes(line)).toEqual(
      expect.arrayContaining([
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
      ]),
    );
  }

  it('clears the session cookie and answers 204', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', loggedInCookie(auth, clock));

    expectLoggedOut(res);
  });

  it('answers the same without a session (a second tap, an expired cookie)', async () => {
    expectLoggedOut(await request(app).post('/api/auth/logout').set(SAME_ORIGIN_HEADERS));
  });
});

describe('GET /api/auth/me', () => {
  it('answers 401 unauthenticated without a session', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
  });
});

describe('protected routes', () => {
  it('answer 401 without a cookie: GET /api/collector/orders', async () => {
    const res = await request(app).get('/api/collector/orders');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
  });

  // The probe path must stay unserved: a real collector route would answer 200 and hide whether
  // the guard let the request through (section 6 made /api/collector/orders a real route).
  it('let a logged-in request past the guard: 404 not_found for a path no route serves', async () => {
    const line = setCookieLine(await login(FAKE_COLLECTOR_PASSWORD));

    const res = await request(app)
      .get('/api/collector/no-such-route')
      .set('Cookie', sessionCookieHeader(setCookieValue(line ?? '')));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
  });
});

describe('logging', () => {
  /** All text written to the console, for "does not contain" checks. */
  function allLogText(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String)
      .join('\n');
  }

  it('logs nothing on any login, logout or session check', async () => {
    const line = setCookieLine(await login(FAKE_COLLECTOR_PASSWORD));
    const cookie = sessionCookieHeader(setCookieValue(line ?? ''));
    await failLogins(5);
    expectRateLimited(await login(WRONG_PASSWORD));
    await login('');
    await request(app).get('/api/auth/me').set('Cookie', cookie);
    await request(app).get('/api/collector/orders').set('Cookie', cookie);
    await request(app).post('/api/auth/logout').set(SAME_ORIGIN_HEADERS).set('Cookie', cookie);

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('logs an outage without the password, the cookie or the IP', async () => {
    const cookie = loggedInCookie(auth, clock);
    const outage = new Error(`store failed for ${IP}`);
    const down: AttemptStore = {
      hit: () => Promise.reject(outage),
      count: () => Promise.reject(outage),
      reset: () => Promise.reject(outage),
    };
    const target = createApp(createFakeDeps({ attempts: down, auth }));

    await request(target)
      .post('/api/auth/login')
      .set(SAME_ORIGIN_HEADERS)
      .set('X-Forwarded-For', IP)
      .set('Cookie', cookie)
      .send({ password: FAKE_COLLECTOR_PASSWORD });

    expect(consoleSpies[0]).toHaveBeenCalledTimes(1);
    const logText = allLogText();
    expect(logText).not.toContain(FAKE_COLLECTOR_PASSWORD);
    expect(logText).not.toContain(cookie.slice('session='.length));
    expect(logText).not.toContain(IP);
  });
});
