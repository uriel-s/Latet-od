import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@bottlerun/shared';
import { fetchSession, login, logout } from './authApi.ts';
import { makeFakeFetch, type FakeAnswer } from './fakeFetch.ts';
import { describeEveryEndpoint } from './request.contract.ts';

/** The 200 body of login and of /me. */
const ME: MeResponse = { user: { sub: 'collector' } };

/** A sentence password with spaces at both ends: it must reach the api exactly as typed. */
const PASSWORD = '  שמש עולה מעל ההרים הירוקים  ';

/** Bodies of a 200 that are not a session user: each must answer `failed`. */
const NOT_A_SESSION_USER: FakeAnswer[] = [
  { status: 200, body: { user: { sub: 'admin' } } },
  { status: 200, body: {} },
  { status: 200, text: '<html>ok</html>' },
];

describe('login', () => {
  it('posts the password, untrimmed, as JSON to /api/auth/login', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ME });

    await login(PASSWORD, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/auth/login');
    expect(calls[0]?.init?.method).toBe('POST');
    // No Origin and no credentials of its own: the browser adds both to a same-origin request.
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.credentials).toBeUndefined();
    const body = calls[0]?.init?.body;
    if (typeof body !== 'string') throw new Error('expected a JSON string body');
    expect(JSON.parse(body)).toEqual({ password: PASSWORD });
  });

  it('answers loggedIn with the session user on 200', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ME });

    expect(await login(PASSWORD, fetchFn)).toEqual({
      kind: 'loggedIn',
      user: { sub: 'collector' },
    });
  });

  it('answers failed on a 200 whose body is not a session user', async () => {
    for (const answer of NOT_A_SESSION_USER) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await login(PASSWORD, fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('answers wrongPassword with the shared message on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'invalid_credentials', message: 'x' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await login(PASSWORD, fetchFn)).toEqual({
        kind: 'wrongPassword',
        message: 'הסיסמה שגויה.',
      });
    }
  });

  it('answers rateLimited with the shared message on 429, also with a body that is not JSON', async () => {
    for (const answer of [
      { status: 429, body: { error: 'rate_limited', message: 'x' } },
      { status: 429, text: '<html>Too Many Requests</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await login(PASSWORD, fetchFn)).toEqual({
        kind: 'rateLimited',
        message: 'יותר מדי ניסיונות כניסה. נא לנסות שוב מאוחר יותר.',
      });
    }
  });
});

describe('fetchSession', () => {
  it('asks GET /api/auth/me, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ME });

    await fetchSession(fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/auth/me');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('answers loggedIn with the session user on 200', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ME });

    expect(await fetchSession(fetchFn)).toEqual({ kind: 'loggedIn', user: { sub: 'collector' } });
  });

  it('answers failed on a 200 whose body is not a session user', async () => {
    for (const answer of NOT_A_SESSION_USER) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchSession(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });
});

describe('logout', () => {
  it('posts to /api/auth/logout and answers true on 204', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 204, noBody: true });

    expect(await logout(fetchFn)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/auth/logout');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});

describeEveryEndpoint(
  [
    {
      name: 'login',
      call: (fetchFn) => login(PASSWORD, fetchFn),
      success: { status: 200, body: ME },
      on401: null,
      alsoFailed: [400, 404],
    },
    {
      name: 'fetchSession',
      call: (fetchFn) => fetchSession(fetchFn),
      success: { status: 200, body: ME },
      on401: 'loggedOut',
      alsoFailed: [404, 429],
    },
    {
      name: 'logout',
      call: async (fetchFn) => ((await logout(fetchFn)) ? { kind: 'cleared' } : { kind: 'failed' }),
      success: { status: 204, noBody: true },
      on401: 'failed',
      // Only the 204 clears the session: even a 200 is not the logout route's answer.
      alsoFailed: [200, 400, 404],
    },
  ],
  [PASSWORD.trim()],
);
