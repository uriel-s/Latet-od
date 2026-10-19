// Tests of the collector guard (ADR-0004) through supertest against createApp(fakes): on
// /api/collector/* (every collector route of sections 6+) and on GET /api/auth/me. Sessions are
// signed in the test with the app's own secret, and time is driven with the injected `auth.now`.
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SessionPayload } from '@bottlerun/shared';
import { createApp } from '../app.ts';
import type { AuthDeps } from '../deps.ts';
import { errorHandler } from '../errors.ts';
import { createFakeAuth, createFakeDeps } from '../fakeDeps.ts';
import { sessionUserOf } from './requireCollector.ts';
import { SESSION_MAX_AGE_MS, newSessionPayload, verifySession } from './session.ts';
import {
  epochSeconds,
  loggedInCookie,
  sessionCookieHeader,
  setCookieAttributes,
  setCookieLine,
  setCookieValue,
  signedToken,
} from './testSession.ts';

const ISSUED_AT = new Date('2026-10-20T09:00:00.000Z');
const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
const DAY_MS = 24 * HOUR_MS;

/** Paths behind the guard: a collector path no route serves yet, and "who is logged in". */
const COLLECTOR_PATH = '/api/collector/orders';
const ME_PATH = '/api/auth/me';

let clock: Date;
let auth: AuthDeps;
let app: Express;
let consoleSpies: MockInstance<typeof console.error>[];

beforeEach(() => {
  clock = ISSUED_AT;
  auth = createFakeAuth({ now: () => clock });
  app = createApp(createFakeDeps({ auth }));
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

/** GETs `path` with `cookie` as the Cookie header (none when undefined). */
function get(path: string, cookie?: string): request.Test {
  const req = request(app).get(path);
  return cookie === undefined ? req : req.set('Cookie', cookie);
}

/** Expects the guard's 401: the error body, never cached, and no cookie set. */
function expectUnauthenticated(res: request.Response): void {
  expect(res.status).toBe(401);
  expect(res.body).toStrictEqual({ error: 'unauthenticated' });
  expect(res.headers['cache-control']).toBe('no-store');
  expect(setCookieLine(res)).toBeUndefined();
}

describe('requireCollector: without a valid session', () => {
  it('answers 401 unauthenticated without a cookie', async () => {
    expectUnauthenticated(await get(COLLECTOR_PATH));
    expectUnauthenticated(await get(ME_PATH));
  });

  it('answers 401 when the request has cookies, but no session', async () => {
    expectUnauthenticated(await get(COLLECTOR_PATH, 'theme=dark; lang=he'));
  });

  it('answers 401 to an expired session, on /api/auth/me and on /api/collector/*', async () => {
    const expired: SessionPayload = {
      sub: 'collector',
      iat: epochSeconds(ISSUED_AT) - 91 * 24 * 60 * 60,
      exp: epochSeconds(ISSUED_AT) - 1,
    };
    const cookie = sessionCookieHeader(signedToken(auth, expired));

    expectUnauthenticated(await get(ME_PATH, cookie));
    expectUnauthenticated(await get('/api/collector/x', cookie));
  });

  it('answers 401 once 90 days have passed without a request', async () => {
    const cookie = loggedInCookie(auth, ISSUED_AT);

    advance(SESSION_MAX_AGE_MS);

    expectUnauthenticated(await get(ME_PATH, cookie));
  });

  it('answers 401 to a tampered session: a later exp with the old signature', async () => {
    const token = signedToken(auth, newSessionPayload({ sub: 'collector' }, ISSUED_AT));
    const [, signature] = token.split('.');
    const extended = { sub: 'collector', iat: epochSeconds(ISSUED_AT), exp: 9_999_999_999 };
    const forged = `${Buffer.from(JSON.stringify(extended)).toString('base64url')}.${signature}`;

    expectUnauthenticated(await get(ME_PATH, sessionCookieHeader(forged)));
    expectUnauthenticated(await get(COLLECTOR_PATH, sessionCookieHeader(forged)));
  });

  it('answers 401 to a session signed with another secret (e.g. before SESSION_SECRET was replaced)', async () => {
    const otherApp = createFakeAuth({ now: () => clock });
    const cookie = loggedInCookie(otherApp, ISSUED_AT);

    expectUnauthenticated(await get(ME_PATH, cookie));
    expectUnauthenticated(await get(COLLECTOR_PATH, cookie));
  });

  it.each([
    ['empty', ''],
    ['one word', 'garbage'],
    ['two parts that are not a token', 'abc.def'],
    ['three parts', 'a.b.c'],
    ['URL-encoded', 'eyJzdWIiOiJjb2xsZWN0b3IifQ%2Eabc'],
  ])('answers 401 to a garbage session cookie: %s', async (_label, token) => {
    expectUnauthenticated(await get(ME_PATH, sessionCookieHeader(token)));
  });
});

describe('requireCollector: with a valid session', () => {
  it('lets the request through: an unknown collector path then answers 404 not_found', async () => {
    const res = await get(COLLECTOR_PATH, loggedInCookie(auth, ISSUED_AT));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'not_found' });
  });

  it('answers GET /api/auth/me with the logged-in user, never cached', async () => {
    const res = await get(ME_PATH, loggedInCookie(auth, ISSUED_AT));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ user: { sub: 'collector' } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('finds the session among other cookies', async () => {
    const cookie = `theme=dark; ${loggedInCookie(auth, ISSUED_AT)}; lang=he`;

    expect((await get(ME_PATH, cookie)).status).toBe(200);
  });

  it('does not renew a session issued less than a day ago', async () => {
    const cookie = loggedInCookie(auth, ISSUED_AT);
    advance(23 * HOUR_MS);

    const res = await get(ME_PATH, cookie);

    expect(res.status).toBe(200);
    expect(setCookieLine(res)).toBeUndefined();
  });

  it('does not renew a session issued exactly a day ago', async () => {
    const cookie = loggedInCookie(auth, ISSUED_AT);
    advance(DAY_MS);

    expect(setCookieLine(await get(ME_PATH, cookie))).toBeUndefined();
  });

  it('renews a session issued more than a day ago: a new cookie issued now, for 90 days', async () => {
    const cookie = loggedInCookie(auth, ISSUED_AT);
    advance(DAY_MS + SECOND_MS);

    const res = await get(ME_PATH, cookie);

    expect(res.status).toBe(200);
    const line = setCookieLine(res);
    expect(line).toBeDefined();
    const renewed = verifySession(setCookieValue(line ?? ''), auth.sessionSecret, clock);
    expect(renewed).toStrictEqual(newSessionPayload({ sub: 'collector' }, clock));
    expect(renewed?.iat).toBe(epochSeconds(clock));
    expect(setCookieAttributes(line ?? '')).toEqual(
      expect.arrayContaining(['Max-Age=7776000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
  });

  it('renews on /api/collector/* too, whatever the route answers', async () => {
    const cookie = loggedInCookie(auth, ISSUED_AT);
    advance(2 * DAY_MS);

    const res = await get(COLLECTOR_PATH, cookie);

    expect(res.status).toBe(404);
    expect(setCookieLine(res)).toBeDefined();
  });

  it('keeps Yoel logged in past 90 days as long as he uses the app in between', async () => {
    const first = loggedInCookie(auth, ISSUED_AT);
    advance(80 * DAY_MS);
    const renewal = setCookieLine(await get(ME_PATH, first));
    const renewed = sessionCookieHeader(setCookieValue(renewal ?? ''));

    // 160 days after the login: the first cookie has expired, the renewed one has not.
    advance(80 * DAY_MS);

    expectUnauthenticated(await get(ME_PATH, first));
    expect((await get(ME_PATH, renewed)).status).toBe(200);
  });

  it('logs nothing, so the cookie never reaches the log', async () => {
    const cookie = loggedInCookie(auth, ISSUED_AT);
    advance(2 * DAY_MS);

    await get(ME_PATH, cookie);
    await get(COLLECTOR_PATH, cookie);
    await get(ME_PATH, sessionCookieHeader('garbage'));

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('sessionUserOf', () => {
  it('fails loudly (500) on a route mounted without the guard', async () => {
    const unguarded = express();
    unguarded.get('/unguarded', (_req, res) => {
      res.json({ user: sessionUserOf(res) });
    });
    unguarded.use(errorHandler);

    const res = await request(unguarded).get('/unguarded');

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: 'internal' });
  });
});
