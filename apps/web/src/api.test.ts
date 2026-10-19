import { describe, expect, it } from 'vitest';
import type { CreateOrderRequest, CreateOrderResponse, MeResponse } from '@bottlerun/shared';
import { createOrder, fetchSession, login, logout, warmUp, type FetchFn } from './api.ts';
import { UNKNOWN_FIELD_ERROR } from './orderForm/formValues.ts';

/**
 * One answer of the fake fetch: an HTTP answer with a JSON (or raw text) body, one with no body
 * at all (a 204, which a Response cannot carry a body with), or no answer.
 */
type FakeAnswer =
  | { status: number; body: unknown }
  | { status: number; text: string }
  | { status: number; noBody: true }
  | 'networkError'
  | 'throws';

interface RecordedCall {
  input: string;
  init: RequestInit | undefined;
}

/**
 * A fake fetch that records every call and gives the `answers` in order. A network error is what
 * a browser's fetch does with no connection: it rejects with a TypeError.
 */
function makeFakeFetch(...answers: FakeAnswer[]): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchFn = (input, init) => {
    calls.push({ input, init });
    const answer = answers[calls.length - 1];
    if (answer === undefined) return Promise.reject(new Error(`unexpected call ${calls.length}`));
    if (answer === 'networkError') return Promise.reject(new TypeError('Failed to fetch'));
    if (answer === 'throws') throw new TypeError('fetch is not a function');
    const body =
      'noBody' in answer ? null : 'text' in answer ? answer.text : JSON.stringify(answer.body);
    return Promise.resolve(
      new Response(body, {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchFn, calls };
}

const REQUEST: CreateOrderRequest = {
  contact: { name: 'משה כהן', phone: '+972501234567' },
  address: {
    streetCode: 247,
    streetName: 'דרך רבין יצחק',
    houseNumber: '12',
    bottlesSpot: 'privateHouse',
  },
  bottlesEstimated: 45,
  website: '',
};

const CREATED: CreateOrderResponse = {
  token: 'a'.repeat(43),
  order: {
    contact: { name: 'משה כהן', phone: '+972501234567' },
    address: {
      streetCode: 247,
      streetName: 'דרך רבין יצחק',
      houseNumber: '12',
      bottlesSpot: 'privateHouse',
    },
    bottlesEstimated: 45,
  },
};

/** Lets every pending promise callback, and Node's unhandled-rejection check, run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createOrder', () => {
  it('posts the request as JSON to /api/orders', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 201, body: CREATED });

    await createOrder(REQUEST, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/orders');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    const body = calls[0]?.init?.body;
    if (typeof body !== 'string') throw new Error('expected a JSON string body');
    expect(JSON.parse(body)).toEqual(REQUEST);
  });

  it('answers created with the parsed token and order summary on 201', async () => {
    const { fetchFn } = makeFakeFetch({ status: 201, body: CREATED });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({ kind: 'created', response: CREATED });
  });

  it('answers failed on a 201 whose body is not a valid response', async () => {
    const { fetchFn } = makeFakeFetch({ status: 201, body: { token: 'short', order: {} } });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({ kind: 'failed' });
  });

  it('answers failed on a 201 whose body is not JSON', async () => {
    const { fetchFn } = makeFakeFetch({ status: 201, text: '<html>ok</html>' });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({ kind: 'failed' });
  });

  it('maps the field errors of a 400 onto the form fields', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: {
        error: 'invalid_order',
        fieldErrors: { bottlesEstimated: 'צריך לפחות 30 בקבוקים', 'address.streetCode': 'x' },
      },
    });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({
      kind: 'invalid',
      errors: { byField: { bottlesEstimated: 'צריך לפחות 30 בקבוקים', street: 'x' } },
    });
  });

  it('keeps an unknown field error of a 400 as a message above the form', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: { error: 'invalid_order', fieldErrors: { 'contact.email': 'x' } },
    });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({
      kind: 'invalid',
      errors: { byField: {}, other: UNKNOWN_FIELD_ERROR },
    });
  });

  it('answers a 400 without usable field errors with a message above the form', async () => {
    for (const answer of [
      { status: 400, body: { error: 'invalid_json' } },
      { status: 400, body: { error: 'invalid_order', fieldErrors: { 'contact.name': 42 } } },
      { status: 400, body: { error: 'invalid_order', fieldErrors: ['contact.name'] } },
      { status: 400, text: 'Bad Request' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await createOrder(REQUEST, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'invalid',
        errors: { byField: {}, other: UNKNOWN_FIELD_ERROR },
      });
    }
  });

  it('answers duplicate with the spec message on 409', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'duplicate_open_order', message: 'anything' },
    });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({
      kind: 'duplicate',
      message: 'כבר יש הזמנה פתוחה למספר הזה.',
    });
  });

  it('answers rateLimited with the shared message on 429, also with a body that is not JSON', async () => {
    for (const answer of [
      { status: 429, body: { error: 'rate_limited', message: 'x' } },
      { status: 429, text: '<html>Too Many Requests</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await createOrder(REQUEST, fetchFn)).toEqual({
        kind: 'rateLimited',
        message: 'יותר מדי ניסיונות. נא לנסות שוב מאוחר יותר.',
      });
    }
  });

  it('answers failed on a 500 and does not retry it', async () => {
    const { fetchFn, calls } = makeFakeFetch(
      { status: 500, body: { error: 'internal' } },
      { status: 201, body: CREATED },
    );

    expect(await createOrder(REQUEST, fetchFn)).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(1);
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [404, 413, 502, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await createOrder(REQUEST, fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('retries once after a network error and answers what the retry got', async () => {
    const { fetchFn, calls } = makeFakeFetch('networkError', { status: 201, body: CREATED });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({ kind: 'created', response: CREATED });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.body).toBe(calls[0]?.init?.body);
  });

  it('treats a fetch that throws instead of rejecting as a network error', async () => {
    const { fetchFn, calls } = makeFakeFetch('throws', { status: 201, body: CREATED });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({ kind: 'created', response: CREATED });
    expect(calls).toHaveLength(2);
  });

  it('answers failed after two network errors, with exactly two calls', async () => {
    const { fetchFn, calls } = makeFakeFetch('networkError', 'networkError', {
      status: 201,
      body: CREATED,
    });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(2);
  });

  it('answers duplicate when the first answer was lost and the retry finds the order it made', async () => {
    const { fetchFn } = makeFakeFetch('networkError', {
      status: 409,
      body: { error: 'duplicate_open_order', message: 'כבר יש הזמנה פתוחה למספר הזה.' },
    });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({
      kind: 'duplicate',
      message: 'כבר יש הזמנה פתוחה למספר הזה.',
    });
  });
});

describe('warmUp', () => {
  it('sends GET /api/health once', () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { ok: true } });

    warmUp(fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/health');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('swallows a network error without throwing or an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { fetchFn } = makeFakeFetch('networkError');
      expect(() => warmUp(fetchFn)).not.toThrow();
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('swallows a fetch that throws instead of rejecting', () => {
    const { fetchFn } = makeFakeFetch('throws');

    expect(() => warmUp(fetchFn)).not.toThrow();
  });

  it('ignores an answer that reports the database down', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 503, body: { ok: false } });

    expect(() => warmUp(fetchFn)).not.toThrow();
    await settle();
    expect(calls).toHaveLength(1);
  });
});

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

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [400, 403, 404, 500, 502, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await login(PASSWORD, fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error and does not retry it', async () => {
    const { fetchFn, calls } = makeFakeFetch('networkError', { status: 200, body: ME });

    expect(await login(PASSWORD, fetchFn)).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(1);
  });

  it('treats a fetch that throws instead of rejecting as a network error', async () => {
    const { fetchFn, calls } = makeFakeFetch('throws', { status: 200, body: ME });

    expect(await login(PASSWORD, fetchFn)).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(1);
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

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchSession(fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('answers failed, not loggedOut, on any other status', async () => {
    for (const status of [403, 404, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await fetchSession(fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 200, body: ME });
      expect(await fetchSession(fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
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

  it('answers false on an error status', async () => {
    for (const status of [403, 500, 503]) {
      const { fetchFn } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await logout(fetchFn), String(status)).toBe(false);
    }
  });

  it('answers false after a network error or a fetch that throws, without a retry', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 204, noBody: true });
      expect(await logout(fetchFn), answer).toBe(false);
      expect(calls, answer).toHaveLength(1);
    }
  });
});
