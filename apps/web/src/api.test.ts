import { describe, expect, it } from 'vitest';
import type {
  AddOrderRequest,
  CollectorOrder,
  CreateOrderRequest,
  CreateOrderResponse,
  CustomerOrder,
  CustomerUpdateOrderRequest,
  MeResponse,
  OrderGroup,
  PlanRoundRequest,
  RoundView,
  RoundsResponse,
  UpdateOrderRequest,
} from '@bottlerun/shared';
import {
  addCollectorOrder,
  buildRoute,
  cancelCollectorOrder,
  cancelCustomerOrder,
  collectStop,
  confirmCustomerOrder,
  confirmOrderByPhone,
  createOrder,
  declineCustomerOrder,
  fetchCollectorOrder,
  fetchCustomerOrder,
  fetchRounds,
  fetchSession,
  fetchWaitingOrders,
  login,
  logout,
  markMessageOpened,
  markStopNotFound,
  moveStop,
  planRound,
  updateCollectorOrder,
  updateCustomerOrder,
  warmUp,
  type CollectorOrderWriteOutcome,
  type CustomerOrderWriteOutcome,
  type FetchFn,
  type StopActionOutcome,
} from './api.ts';
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

// ---------------------------------------------------------------------------------------------
// The collector's orders: /api/collector/orders
// ---------------------------------------------------------------------------------------------

/**
 * One order as Yoel's screens get it. The fake fetch's JSON.stringify writes `createdAt` as the
 * ISO string the api sends, so a parsed answer equal to this one has turned it back into a Date.
 */
const ORDER: CollectorOrder = {
  id: '6710f3a2c4b5d6e7f8a9b0c1',
  contact: { name: 'משה כהן', phone: '+972501234567' },
  address: {
    streetCode: 247,
    streetName: 'דרך רבין יצחק',
    houseNumber: '12א',
    bottlesSpot: 'apartmentDoor',
    floorApt: 'קומה 3, דירה 12',
  },
  bottlesEstimated: 45,
  status: 'waiting',
  region: 'ramat',
  lastMiss: { date: '2026-10-12', reason: 'notConfirmed', roundId: 'round-0' },
  source: 'collector',
  createdAt: new Date('2026-10-19T08:30:00.000Z'),
  hasLocation: true,
};

/** The three groups of the "הזמנות" screen, as GET /api/collector/orders answers them. */
const GROUPS: OrderGroup[] = [
  { key: 'ramat', orderCount: 1, bottlesTotal: 45, orders: [ORDER] },
  { key: 'old', orderCount: 0, bottlesTotal: 0, orders: [] },
  { key: 'none', orderCount: 0, bottlesTotal: 0, orders: [] },
];

/** An id that is not a path segment as it is: its `/`, `?` and `#` must be encoded. */
const ODD_ID = 'a/b?c#d';
const ODD_ID_IN_PATH = 'a%2Fb%3Fc%23d';

/** Yoel's "הוספת הזמנה": the booking form's request without the honeypot. */
const ADD_REQUEST: AddOrderRequest = {
  contact: { name: 'רחל לוי', phone: '052-7654321' },
  address: { streetName: 'הרימון', houseNumber: '7', bottlesSpot: 'buildingEntrance' },
  bottlesEstimated: '60',
};

/** An edit: a new count, an explicit region, and the near street removed (null). */
const UPDATE_REQUEST: UpdateOrderRequest = {
  bottlesEstimated: 60,
  region: 'old',
  nearStreetCode: null,
};

/** The JSON body of a recorded call, parsed; fails the test when it has no string body. */
function jsonBodyOf(call: RecordedCall | undefined): unknown {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body);
}

/** Bodies of a success that are not a `CollectorOrderResponse`: each must answer `failed`. */
const NOT_AN_ORDER: ({ body: unknown } | { text: string })[] = [
  { body: { order: { ...ORDER, status: 'archived' } } },
  { body: { order: { ...ORDER, createdAt: 'yesterday' } } },
  { body: ORDER },
  { body: {} },
  { text: '<html>ok</html>' },
];

describe('fetchWaitingOrders', () => {
  it('asks GET /api/collector/orders, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { groups: GROUPS } });

    await fetchWaitingOrders(fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/orders');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('answers loaded with the groups on 200, createdAt parsed into a Date', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: { groups: GROUPS } });

    const outcome = await fetchWaitingOrders(fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', groups: GROUPS });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.groups[0]?.orders[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not the groups', async () => {
    for (const answer of [
      { status: 200, body: { groups: [{ ...GROUPS[0], key: 'north' }] } },
      { status: 200, body: { groups: [{ ...GROUPS[0], orders: [{ ...ORDER, id: '' }] }] } },
      { status: 200, body: GROUPS },
      { status: 200, text: '<html>ok</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchWaitingOrders(fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchWaitingOrders(fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [403, 404, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await fetchWaitingOrders(fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 200, body: { groups: GROUPS } });
      expect(await fetchWaitingOrders(fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

describe('fetchCollectorOrder', () => {
  it('asks GET /api/collector/orders/:id with the id encoded, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { order: ORDER } });

    await fetchCollectorOrder(ODD_ID, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/orders/${ODD_ID_IN_PATH}`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('answers loaded with the order on 200, createdAt parsed into a Date', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: { order: ORDER } });

    const outcome = await fetchCollectorOrder(ORDER.id, fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', order: ORDER });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.order.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not an order', async () => {
    for (const answer of NOT_AN_ORDER) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await fetchCollectorOrder(ORDER.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers notFound on 404', async () => {
    const { fetchFn } = makeFakeFetch({ status: 404, body: { error: 'order_not_found' } });

    expect(await fetchCollectorOrder(ORDER.id, fetchFn)).toEqual({ kind: 'notFound' });
  });

  it('answers loggedOut on 401', async () => {
    const { fetchFn } = makeFakeFetch({ status: 401, body: { error: 'unauthenticated' } });

    expect(await fetchCollectorOrder(ORDER.id, fetchFn)).toEqual({ kind: 'loggedOut' });
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [400, 403, 409, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await fetchCollectorOrder(ORDER.id, fetchFn), String(status)).toEqual({
        kind: 'failed',
      });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 200, body: { order: ORDER } });
      expect(await fetchCollectorOrder(ORDER.id, fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

describe('addCollectorOrder', () => {
  it('posts the request as JSON to /api/collector/orders', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 201, body: { order: ORDER } });

    await addCollectorOrder(ADD_REQUEST, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/orders');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(jsonBodyOf(calls[0])).toEqual(ADD_REQUEST);
  });

  it('answers failed on a 404: an add has no order to be missing', async () => {
    const { fetchFn } = makeFakeFetch({ status: 404, body: { error: 'order_not_found' } });

    expect(await addCollectorOrder(ADD_REQUEST, fetchFn)).toEqual({ kind: 'failed' });
  });
});

describe('updateCollectorOrder', () => {
  it('patches /api/collector/orders/:id with the id encoded and the request as JSON', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { order: ORDER } });

    await updateCollectorOrder(ODD_ID, UPDATE_REQUEST, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/orders/${ODD_ID_IN_PATH}`);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    // `nearStreetCode: null` is sent, not dropped: it is what removes the near street.
    expect(jsonBodyOf(calls[0])).toEqual({
      bottlesEstimated: 60,
      region: 'old',
      nearStreetCode: null,
    });
  });
});

describe('cancelCollectorOrder', () => {
  it('posts to /api/collector/orders/:id/cancel with the id encoded and no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { order: ORDER } });

    await cancelCollectorOrder(ODD_ID, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/orders/${ODD_ID_IN_PATH}/cancel`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});

/** One of the three writes, called with a fake fetch. */
interface CollectorWrite {
  name: string;
  /** 201 for the add, 200 for an edit or a cancel. */
  successStatus: number;
  write: (fetchFn: FetchFn) => Promise<CollectorOrderWriteOutcome>;
}

/**
 * The three writes share every answer but their success status and the 404, which only an edit or
 * a cancel can mean as "the order is gone".
 */
const WRITES: CollectorWrite[] = [
  {
    name: 'addCollectorOrder',
    successStatus: 201,
    write: (fetchFn) => addCollectorOrder(ADD_REQUEST, fetchFn),
  },
  {
    name: 'updateCollectorOrder',
    successStatus: 200,
    write: (fetchFn) => updateCollectorOrder(ORDER.id, UPDATE_REQUEST, fetchFn),
  },
  {
    name: 'cancelCollectorOrder',
    successStatus: 200,
    write: (fetchFn) => cancelCollectorOrder(ORDER.id, fetchFn),
  },
];

describe.each(WRITES)('$name answers', ({ successStatus, write }) => {
  it('saved with the stored order on its success status, createdAt parsed into a Date', async () => {
    const { fetchFn } = makeFakeFetch({ status: successStatus, body: { order: ORDER } });

    const outcome = await write(fetchFn);

    expect(outcome).toEqual({ kind: 'saved', order: ORDER });
    if (outcome.kind !== 'saved') throw new Error('expected saved');
    expect(outcome.order.createdAt).toBeInstanceOf(Date);
  });

  it('failed on a success whose body is not an order', async () => {
    for (const answer of NOT_AN_ORDER) {
      const { fetchFn } = makeFakeFetch({ status: successStatus, ...answer });
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('failed on a success status that is not its own', async () => {
    const { fetchFn } = makeFakeFetch({
      status: successStatus === 201 ? 200 : 201,
      body: { order: ORDER },
    });

    expect(await write(fetchFn)).toEqual({ kind: 'failed' });
  });

  it('invalid on a 400, with a path no field shows (nearStreetCode) above the form', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: {
        error: 'invalid_order',
        fieldErrors: { 'contact.phone': 'מספר נייד לא תקין', nearStreetCode: 'הרחוב לא נמצא' },
      },
    });

    expect(await write(fetchFn)).toEqual({
      kind: 'invalid',
      errors: { byField: { phone: 'מספר נייד לא תקין' }, other: UNKNOWN_FIELD_ERROR },
    });
  });

  it('invalid with a message above the form on a 400 without usable field errors', async () => {
    for (const answer of [
      { status: 400, body: { error: 'invalid_order', fieldErrors: {} } },
      { status: 400, body: { error: 'invalid_json' } },
      { status: 400, text: 'Bad Request' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'invalid',
        errors: { byField: {}, other: UNKNOWN_FIELD_ERROR },
      });
    }
  });

  it('duplicate with the shared message on a 409 duplicate_open_order', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'duplicate_open_order', message: 'anything' },
    });

    expect(await write(fetchFn)).toEqual({
      kind: 'duplicate',
      message: 'כבר יש הזמנה פתוחה למספר הזה.',
    });
  });

  it('closed with the shared message on a 409 invalid_transition', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'invalid_transition', message: 'anything' },
    });

    expect(await write(fetchFn)).toEqual({
      kind: 'closed',
      message: 'ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.',
    });
  });

  it('failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'conflict', message: 'x' } },
      { status: 409, body: { message: 'x' } },
      { status: 409, body: ['duplicate_open_order'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await write(fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('failed on any other status, without a retry', async () => {
    for (const status of [403, 413, 429, 500, 502, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await write(fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, {
        status: successStatus,
        body: { order: ORDER },
      });
      expect(await write(fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

describe.each(WRITES.filter(({ name }) => name !== 'addCollectorOrder'))(
  '$name answers',
  ({ write }) => {
    it('notFound with the shared message on 404', async () => {
      const { fetchFn } = makeFakeFetch({ status: 404, body: { error: 'order_not_found' } });

      expect(await write(fetchFn)).toEqual({ kind: 'notFound', message: 'ההזמנה לא נמצאה.' });
    });
  },
);

// ---------------------------------------------------------------------------------------------
// The "שלח" list: POST /api/collector/orders/:id/messages/:index/opened
// ---------------------------------------------------------------------------------------------

/** The first time the link was opened, as the api stores it (JSON.stringify sends it as ISO). */
const OPENED_AT = new Date('2026-10-20T07:15:00.000Z');

describe('markMessageOpened', () => {
  it('posts to /api/collector/orders/:id/messages/:index/opened with the id encoded and no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { openedAt: OPENED_AT } });

    await markMessageOpened(ODD_ID, 3, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/orders/${ODD_ID_IN_PATH}/messages/3/opened`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('answers marked with openedAt parsed into a Date on 200', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: { openedAt: OPENED_AT } });

    const outcome = await markMessageOpened(ORDER.id, 0, fetchFn);

    expect(outcome).toEqual({ kind: 'marked', openedAt: OPENED_AT });
    if (outcome.kind !== 'marked') throw new Error('expected marked');
    expect(outcome.openedAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not an openedAt', async () => {
    for (const answer of [
      { status: 200, body: { openedAt: 'yesterday' } },
      { status: 200, body: { openedAt: null } },
      { status: 200, body: {} },
      { status: 200, text: '<html>ok</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await markMessageOpened(ORDER.id, 0, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await markMessageOpened(ORDER.id, 0, fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('answers notFound on a 404, for a missing order and a missing message alike', async () => {
    for (const answer of [
      { status: 404, body: { error: 'order_not_found' } },
      { status: 404, body: { error: 'message_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await markMessageOpened(ORDER.id, 7, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'notFound',
      });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [201, 400, 403, 409, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch(
        { status, body: { error: 'x' } },
        { status: 200, body: { openedAt: OPENED_AT } },
      );
      expect(await markMessageOpened(ORDER.id, 0, fetchFn), String(status)).toEqual({
        kind: 'failed',
      });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, {
        status: 200,
        body: { openedAt: OPENED_AT },
      });
      expect(await markMessageOpened(ORDER.id, 0, fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The collector's rounds: /api/collector/rounds
// ---------------------------------------------------------------------------------------------

/**
 * A planned round with one pending order and its "שלח" row, as the api answers it. JSON.stringify
 * writes the Dates as ISO strings, so a parsed answer equal to this one has turned them back.
 */
const ROUND_VIEW: RoundView = {
  round: {
    id: '6710f3a2c4b5d6e7f8a9b0d2',
    date: '2026-11-12',
    region: 'ramat',
    status: 'open',
    phase: 'confirming',
    personalText: 'תודה רבה!',
    pickupBy: '08:00',
    createdAt: new Date('2026-10-20T07:00:00.000Z'),
  },
  groups: [
    { key: 'confirmed', orders: [] },
    { key: 'pending', orders: [{ ...ORDER, status: 'pending' }] },
    { key: 'otherDate', orders: [] },
  ],
  sendList: [
    {
      orderId: ORDER.id,
      messageIndex: 0,
      kind: 'confirmRequest',
      name: 'משה כהן',
      url: 'https://wa.me/972501234567?text=%D7%A9%D7%9C%D7%95%D7%9D',
    },
  ],
  stops: [],
};

/** The same round once its customer confirmed: no "שלח" row left. */
const CONFIRMED_VIEW: RoundView = {
  ...ROUND_VIEW,
  groups: [
    { key: 'confirmed', orders: [{ ...ORDER, status: 'confirmed' }] },
    { key: 'pending', orders: [] },
    { key: 'otherDate', orders: [] },
  ],
  sendList: [],
};

/** Bodies of a success that are not a `RoundView`: each must answer `failed`. */
const NOT_A_ROUND_VIEW: ({ body: unknown } | { text: string })[] = [
  { body: { ...ROUND_VIEW, round: { ...ROUND_VIEW.round, status: 'archived' } } },
  { body: { ...ROUND_VIEW, round: { ...ROUND_VIEW.round, date: '12/11' } } },
  { body: { ...ROUND_VIEW, groups: [{ key: 'maybe', orders: [] }] } },
  {
    body: { ...ROUND_VIEW, sendList: [{ ...ROUND_VIEW.sendList[0], url: 'javascript:alert(1)' }] },
  },
  { body: { round: ROUND_VIEW.round } },
  { body: { view: ROUND_VIEW } },
  { text: '<html>ok</html>' },
];

describe('fetchRounds', () => {
  const ROUNDS: RoundsResponse = { rounds: [ROUND_VIEW], previousPickupBy: '08:30' };

  it('asks GET /api/collector/rounds, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUNDS });

    await fetchRounds(fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/rounds');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('answers loaded with the rounds and the previous pickup time on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUNDS });

    const outcome = await fetchRounds(fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', rounds: [ROUND_VIEW], previousPickupBy: '08:30' });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.rounds[0]?.round.createdAt).toBeInstanceOf(Date);
    expect(outcome.rounds[0]?.groups[1]?.orders[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('answers loaded without a pickup time when the api has none, and with no rounds', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: { rounds: [] } });

    const outcome = await fetchRounds(fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', rounds: [] });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.previousPickupBy).toBeUndefined();
  });

  it('answers failed on a 200 whose body is not the rounds', async () => {
    for (const answer of [
      { status: 200, body: { rounds: [ROUND_VIEW], previousPickupBy: '8:30' } },
      {
        status: 200,
        body: { rounds: [{ ...ROUND_VIEW, round: { ...ROUND_VIEW.round, id: '' } }] },
      },
      { status: 200, body: [ROUND_VIEW] },
      { status: 200, body: {} },
      { status: 200, text: '<html>ok</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchRounds(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchRounds(fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [201, 403, 404, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: ROUNDS });
      expect(await fetchRounds(fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 200, body: ROUNDS });
      expect(await fetchRounds(fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

describe('planRound', () => {
  /** What the planning screen sends: a pickup time, and its personal text as typed. */
  const PLAN: PlanRoundRequest = {
    date: '2026-11-12',
    region: 'ramat',
    orderIds: [ORDER.id, '6710f3a2c4b5d6e7f8a9b0c9'],
    pickupBy: '08:00',
    personalText: 'תודה רבה!',
  };

  it('posts the request as JSON to /api/collector/rounds', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 201, body: ROUND_VIEW });

    await planRound(PLAN, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/rounds');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(jsonBodyOf(calls[0])).toEqual(PLAN);
  });

  it('answers planned with the round view on 201, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 201, body: ROUND_VIEW });

    const outcome = await planRound(PLAN, fetchFn);

    expect(outcome).toEqual({ kind: 'planned', view: ROUND_VIEW });
    if (outcome.kind !== 'planned') throw new Error('expected planned');
    expect(outcome.view.round.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 201 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUND_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 201, ...answer });
      expect(await planRound(PLAN, fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('answers failed on a 200: only 201 means planned', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUND_VIEW });

    expect(await planRound(PLAN, fetchFn)).toEqual({ kind: 'failed' });
  });

  it('answers invalid with the field errors of a 400 invalid_round', async () => {
    const fieldErrors = { date: 'נא לבחור תאריך', orderIds: 'אפשר לסמן עד 25 הזמנות בסבב' };
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: { error: 'invalid_round', fieldErrors },
    });

    expect(await planRound(PLAN, fetchFn)).toEqual({ kind: 'invalid', fieldErrors });
  });

  it('answers invalid with no field errors on a 400 without usable ones', async () => {
    for (const answer of [
      { status: 400, body: { error: 'invalid_round', fieldErrors: { date: 7 } } },
      { status: 400, body: { error: 'invalid_round', fieldErrors: ['date'] } },
      { status: 400, body: { error: 'invalid_json' } },
      { status: 400, text: 'Bad Request' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await planRound(PLAN, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'invalid',
        fieldErrors: {},
      });
    }
  });

  it('answers ordersNotWaiting with the shared message and the ids on a 409 orders_not_waiting', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'orders_not_waiting', message: 'anything', orderIds: [ORDER.id] },
    });

    expect(await planRound(PLAN, fetchFn)).toEqual({
      kind: 'ordersNotWaiting',
      message: 'חלק מההזמנות כבר לא ממתינות לסבב. נא לרענן את הרשימה ולנסות שוב.',
      orderIds: [ORDER.id],
    });
  });

  it('answers ordersNotWaiting with no ids when the 409 lists none the app can read', async () => {
    for (const orderIds of [undefined, 'o1', [ORDER.id, 7], { 0: ORDER.id }]) {
      const { fetchFn } = makeFakeFetch({
        status: 409,
        body: { error: 'orders_not_waiting', message: 'x', orderIds },
      });
      expect(await planRound(PLAN, fetchFn), JSON.stringify(orderIds)).toEqual({
        kind: 'ordersNotWaiting',
        message: 'חלק מההזמנות כבר לא ממתינות לסבב. נא לרענן את הרשימה ולנסות שוב.',
        orderIds: [],
      });
    }
  });

  it('answers failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'duplicate_open_order', message: 'x' } },
      { status: 409, body: { message: 'x', orderIds: [ORDER.id] } },
      { status: 409, body: ['orders_not_waiting'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await planRound(PLAN, fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await planRound(PLAN, fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [403, 404, 413, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch({ status, body: { error: 'x' } });
      expect(await planRound(PLAN, fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 201, body: ROUND_VIEW });
      expect(await planRound(PLAN, fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

describe('confirmOrderByPhone', () => {
  it('posts to /api/collector/rounds/:id/orders/:orderId/confirm-by-phone, both ids encoded, no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: CONFIRMED_VIEW });

    await confirmOrderByPhone(ODD_ID, 'e/f?g', fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      `/api/collector/rounds/${ODD_ID_IN_PATH}/orders/e%2Ff%3Fg/confirm-by-phone`,
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('answers confirmed with the round view on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: CONFIRMED_VIEW });

    const outcome = await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn);

    expect(outcome).toEqual({ kind: 'confirmed', view: CONFIRMED_VIEW });
    if (outcome.kind !== 'confirmed') throw new Error('expected confirmed');
    expect(outcome.view.groups[0]?.orders[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUND_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(
        await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn),
        JSON.stringify(answer),
      ).toEqual({ kind: 'failed' });
    }
  });

  it('answers closed with the shared message on a 409 confirmations_closed', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'confirmations_closed', message: 'anything' },
    });

    expect(await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn)).toEqual({
      kind: 'closed',
      message: 'האישורים לסבב הזה כבר נסגרו.',
    });
  });

  it('answers closed with the order message on a 409 invalid_transition', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'invalid_transition', message: 'anything' },
    });

    expect(await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn)).toEqual({
      kind: 'closed',
      message: 'ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.',
    });
  });

  it('answers failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'orders_not_waiting', message: 'x', orderIds: [] } },
      { status: 409, body: { message: 'x' } },
      { status: 409, body: ['confirmations_closed'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(
        await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn),
        JSON.stringify(answer),
      ).toEqual({ kind: 'failed' });
    }
  });

  it('answers notFound on a 404, for a missing round and a missing order alike', async () => {
    for (const answer of [
      { status: 404, body: { error: 'round_not_found' } },
      { status: 404, body: { error: 'order_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(
        await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn),
        JSON.stringify(answer),
      ).toEqual({ kind: 'notFound' });
    }
  });

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn)).toEqual({
        kind: 'loggedOut',
      });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [201, 400, 403, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch(
        { status, body: { error: 'x' } },
        { status: 200, body: CONFIRMED_VIEW },
      );
      expect(
        await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn),
        String(status),
      ).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 200, body: CONFIRMED_VIEW });
      expect(await confirmOrderByPhone(ROUND_VIEW.round.id, ORDER.id, fetchFn), answer).toEqual({
        kind: 'failed',
      });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

/** A second order of the routed round, still to collect, at a street with no map point. */
const SECOND_ORDER: CollectorOrder = {
  ...ORDER,
  id: '6710f3a2c4b5d6e7f8a9b0c9',
  status: 'confirmed',
  hasLocation: false,
};

/**
 * The round once its route is built and its first stop collected: that stop carries its
 * "שלח תודה" row, the second is still to collect.
 */
const ROUTED_VIEW: RoundView = {
  ...ROUND_VIEW,
  round: { ...ROUND_VIEW.round, phase: 'routed' },
  groups: [
    { key: 'confirmed', orders: [{ ...ORDER, status: 'collected' }, SECOND_ORDER] },
    { key: 'pending', orders: [] },
    { key: 'otherDate', orders: [] },
  ],
  sendList: [],
  stops: [
    {
      order: { ...ORDER, status: 'collected' },
      hasLocation: true,
      state: 'collected',
      thankYou: {
        orderId: ORDER.id,
        messageIndex: 1,
        kind: 'thankYou',
        name: 'משה כהן',
        url: 'https://wa.me/972501234567?text=%D7%AA%D7%95%D7%93%D7%94',
      },
    },
    { order: SECOND_ORDER, hasLocation: false, state: 'toCollect' },
  ],
};

/** Bodies of a success that are not a routed `RoundView`, on top of {@link NOT_A_ROUND_VIEW}. */
const NOT_A_ROUTED_VIEW: ({ body: unknown } | { text: string })[] = [
  ...NOT_A_ROUND_VIEW,
  { body: { ...ROUTED_VIEW, stops: [{ ...ROUTED_VIEW.stops[0], state: 'maybe' }] } },
  { body: { ...ROUTED_VIEW, stops: undefined } },
];

describe('buildRoute', () => {
  it('posts to /api/collector/rounds/:id/route, the id encoded, no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await buildRoute(ODD_ID, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/rounds/${ODD_ID_IN_PATH}/route`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('answers built with the routed view on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    const outcome = await buildRoute(ROUND_VIEW.round.id, fetchFn);

    expect(outcome).toEqual({ kind: 'built', view: ROUTED_VIEW });
    if (outcome.kind !== 'built') throw new Error('expected built');
    expect(outcome.view.stops[1]?.order.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUTED_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers closed with the shared message on a 409 confirmations_closed', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'confirmations_closed', message: 'anything' },
    });

    expect(await buildRoute(ROUND_VIEW.round.id, fetchFn)).toEqual({
      kind: 'closed',
      message: 'האישורים לסבב הזה כבר נסגרו.',
    });
  });

  it('answers failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'route_not_open', message: 'x' } },
      { status: 409, body: { error: 'invalid_transition', message: 'x' } },
      { status: 409, body: { message: 'x' } },
      { status: 409, body: ['confirmations_closed'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers notFound on a 404', async () => {
    for (const answer of [
      { status: 404, body: { error: 'round_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'notFound',
      });
    }
  });

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [201, 400, 403, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch(
        { status, body: { error: 'x' } },
        { status: 200, body: ROUTED_VIEW },
      );
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), String(status)).toEqual({
        kind: 'failed',
      });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 200, body: ROUTED_VIEW });
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

/** One stop action, called the way the route screen calls it. */
interface StopActionCase {
  name: string;
  act: (roundId: string, orderId: string, fetchFn: FetchFn) => Promise<StopActionOutcome>;
  /** The path's last segment, after `/stops/:orderId/`. */
  action: string;
  /** The JSON body it sends, or undefined for none. */
  body: unknown;
}

const STOP_ACTIONS: StopActionCase[] = [
  {
    name: 'moveStop',
    act: (roundId, orderId, fetchFn) => moveStop(roundId, orderId, 'down', fetchFn),
    action: 'move',
    body: { direction: 'down' },
  },
  {
    name: 'collectStop',
    act: (roundId, orderId, fetchFn) => collectStop(roundId, orderId, undefined, fetchFn),
    action: 'collected',
    body: {},
  },
  {
    name: 'markStopNotFound',
    act: (roundId, orderId, fetchFn) => markStopNotFound(roundId, orderId, fetchFn),
    action: 'not-found',
    body: undefined,
  },
];

describe.each(STOP_ACTIONS)('$name', ({ act, action, body }) => {
  const roundId = ROUND_VIEW.round.id;

  it('posts to /api/collector/rounds/:id/stops/:orderId/<action>, both ids encoded', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await act(ODD_ID, 'e/f?g', fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      `/api/collector/rounds/${ODD_ID_IN_PATH}/stops/e%2Ff%3Fg/${action}`,
    );
    expect(calls[0]?.init?.method).toBe('POST');
    if (body === undefined) {
      expect(calls[0]?.init?.body).toBeUndefined();
      expect(calls[0]?.init?.headers).toBeUndefined();
    } else {
      expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(jsonBodyOf(calls[0])).toEqual(body);
    }
  });

  it('answers saved with the round view on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    const outcome = await act(roundId, ORDER.id, fetchFn);

    expect(outcome).toEqual({ kind: 'saved', view: ROUTED_VIEW });
    if (outcome.kind !== 'saved') throw new Error('expected saved');
    expect(outcome.view.round.createdAt).toBeInstanceOf(Date);
    expect(outcome.view.stops[0]?.order.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUTED_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await act(roundId, ORDER.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers stale with the shared message on a 409 route_not_open', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'route_not_open', message: 'anything' },
    });

    expect(await act(roundId, ORDER.id, fetchFn)).toEqual({
      kind: 'stale',
      message: 'אין מסלול פתוח בסבב הזה. נא לרענן את המסך.',
    });
  });

  it('answers stale with the stop-handled message on a 409 stop_handled or invalid_transition', async () => {
    for (const error of ['stop_handled', 'invalid_transition']) {
      const { fetchFn } = makeFakeFetch({ status: 409, body: { error, message: 'anything' } });
      expect(await act(roundId, ORDER.id, fetchFn), error).toEqual({
        kind: 'stale',
        message: 'העצירה הזאת כבר טופלה. נא לרענן את המסך.',
      });
    }
  });

  it('answers failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'confirmations_closed', message: 'x' } },
      { status: 409, body: { message: 'x' } },
      { status: 409, body: ['route_not_open'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await act(roundId, ORDER.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers notFound on a 404, for a missing round and a missing stop alike', async () => {
    for (const answer of [
      { status: 404, body: { error: 'round_not_found' } },
      { status: 404, body: { error: 'order_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await act(roundId, ORDER.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'notFound',
      });
    }
  });

  it('answers loggedOut on 401, whatever the body says', async () => {
    for (const answer of [
      { status: 401, body: { error: 'unauthenticated' } },
      { status: 401, text: 'Unauthorized' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await act(roundId, ORDER.id, fetchFn)).toEqual({ kind: 'loggedOut' });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [201, 403, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch(
        { status, body: { error: 'x' } },
        { status: 200, body: ROUTED_VIEW },
      );
      expect(await act(roundId, ORDER.id, fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, { status: 200, body: ROUTED_VIEW });
      expect(await act(roundId, ORDER.id, fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

describe('moveStop', () => {
  it('sends the direction it is given', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await moveStop(ROUND_VIEW.round.id, ORDER.id, 'up', fetchFn);

    expect(jsonBodyOf(calls[0])).toEqual({ direction: 'up' });
  });

  it('answers atEdge with the shared message on a 409 stop_at_edge', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'stop_at_edge', message: 'anything' },
    });

    expect(await moveStop(ROUND_VIEW.round.id, ORDER.id, 'up', fetchFn)).toEqual({
      kind: 'atEdge',
      message: 'העצירה כבר בקצה המסלול.',
    });
  });

  it('answers failed on a 400 invalid_move: the screen has no field to show it next to', async () => {
    const { fetchFn } = makeFakeFetch({ status: 400, body: { error: 'invalid_move' } });

    expect(await moveStop(ROUND_VIEW.round.id, ORDER.id, 'up', fetchFn)).toEqual({
      kind: 'failed',
    });
  });
});

describe('collectStop', () => {
  it('sends the count it is given', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await collectStop(ROUND_VIEW.round.id, ORDER.id, 12, fetchFn);

    expect(jsonBodyOf(calls[0])).toEqual({ bottlesCollected: 12 });
  });

  it('sends {} without a count, so the api uses the estimate', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await collectStop(ROUND_VIEW.round.id, ORDER.id, undefined, fetchFn);

    expect(calls[0]?.init?.body).toBe('{}');
  });

  it("answers saved with the collected stop's thank-you row", async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    const outcome = await collectStop(ROUND_VIEW.round.id, ORDER.id, 45, fetchFn);

    if (outcome.kind !== 'saved') throw new Error('expected saved');
    expect(outcome.view.stops[0]?.thankYou?.url).toBe(
      'https://wa.me/972501234567?text=%D7%AA%D7%95%D7%93%D7%94',
    );
  });

  it('answers invalid with the field errors of a 400 invalid_collect', async () => {
    const fieldErrors = { bottlesCollected: 'נא לכתוב כמה בקבוקים נאספו, מספר שלם מ-1 ומעלה' };
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: { error: 'invalid_collect', fieldErrors },
    });

    expect(await collectStop(ROUND_VIEW.round.id, ORDER.id, 0, fetchFn)).toEqual({
      kind: 'invalid',
      fieldErrors,
    });
  });

  it('answers invalid with no field errors on a 400 without usable ones', async () => {
    for (const answer of [
      { status: 400, body: { error: 'invalid_collect', fieldErrors: { bottlesCollected: 0 } } },
      { status: 400, body: { error: 'invalid_collect', fieldErrors: ['bottlesCollected'] } },
      { status: 400, body: { error: 'invalid_json' } },
      { status: 400, text: 'Bad Request' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(
        await collectStop(ROUND_VIEW.round.id, ORDER.id, 0, fetchFn),
        JSON.stringify(answer),
      ).toEqual({ kind: 'invalid', fieldErrors: {} });
    }
  });
});

describe('markStopNotFound', () => {
  it('answers failed on a 400: it sends no body, so there is no field to show', async () => {
    const { fetchFn } = makeFakeFetch({ status: 400, body: { error: 'invalid_json' } });

    expect(await markStopNotFound(ROUND_VIEW.round.id, ORDER.id, fetchFn)).toEqual({
      kind: 'failed',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The customer's own page: /api/o/:token
// ---------------------------------------------------------------------------------------------

/** A token as the api hands it out: 43 base64url characters. */
const TOKEN = 'Ab3_-'.repeat(8) + 'xyz';

/** A token that is not a path segment as it is: its `/`, `?` and `#` must be encoded. */
const ODD_TOKEN = 'a/b?c#d';
const ODD_TOKEN_IN_PATH = 'a%2Fb%3Fc%23d';

/** A pending order of the customer's page, with its round's date and pickup time. */
const CUSTOMER_ORDER: CustomerOrder = {
  contact: { name: 'משה כהן', phone: '+972501234567' },
  address: {
    streetCode: 247,
    streetName: 'דרך רבין יצחק',
    houseNumber: '12א',
    bottlesSpot: 'apartmentDoor',
    floorApt: 'קומה 3, דירה 12',
  },
  bottlesEstimated: 45,
  status: 'pending',
  round: { date: '2026-11-12', pickupBy: '18:00' },
};

/** "שינוי": a new number of bottles, typed as text, and the address with a new note. */
const CUSTOMER_UPDATE: CustomerUpdateOrderRequest = {
  address: {
    streetCode: 247,
    streetName: 'דרך רבין יצחק',
    houseNumber: '12א',
    bottlesSpot: 'privateHouse',
    note: 'ליד השער',
  },
  bottlesEstimated: '60',
};

/** Bodies of a 200 that are not a `CustomerOrderResponse`: each must answer `failed`. */
const NOT_A_CUSTOMER_ORDER: ({ body: unknown } | { text: string })[] = [
  { body: { order: { ...CUSTOMER_ORDER, status: 'archived' } } },
  { body: { order: { ...CUSTOMER_ORDER, round: { date: '12/11' } } } },
  { body: CUSTOMER_ORDER },
  { body: {} },
  { text: '<html>ok</html>' },
];

describe('fetchCustomerOrder', () => {
  it('asks GET /api/o/:token with the token encoded, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { order: CUSTOMER_ORDER } });

    await fetchCustomerOrder(ODD_TOKEN, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/o/${ODD_TOKEN_IN_PATH}`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('puts a real token into the path as it is', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { order: CUSTOMER_ORDER } });

    await fetchCustomerOrder(TOKEN, fetchFn);

    expect(calls[0]?.input).toBe(`/api/o/${TOKEN}`);
  });

  it('answers loaded with the order and its round on 200', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: { order: CUSTOMER_ORDER } });

    expect(await fetchCustomerOrder(TOKEN, fetchFn)).toEqual({
      kind: 'loaded',
      order: CUSTOMER_ORDER,
    });
  });

  it('keeps only the fields the page may show', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 200,
      body: { order: { ...CUSTOMER_ORDER, id: 'o1', token: TOKEN, region: 'ramat' } },
    });

    expect(await fetchCustomerOrder(TOKEN, fetchFn)).toEqual({
      kind: 'loaded',
      order: CUSTOMER_ORDER,
    });
  });

  it('answers failed on a 200 whose body is not an order', async () => {
    for (const answer of NOT_A_CUSTOMER_ORDER) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await fetchCustomerOrder(TOKEN, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers notFound on 404, whatever the body says', async () => {
    for (const answer of [
      { status: 404, body: { error: 'order_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchCustomerOrder(TOKEN, fetchFn)).toEqual({ kind: 'notFound' });
    }
  });

  it('answers failed on any other status, without a retry', async () => {
    for (const status of [201, 400, 401, 403, 409, 429, 500, 503]) {
      const { fetchFn, calls } = makeFakeFetch(
        { status, body: { error: 'x' } },
        { status: 200, body: { order: CUSTOMER_ORDER } },
      );
      expect(await fetchCustomerOrder(TOKEN, fetchFn), String(status)).toEqual({
        kind: 'failed',
      });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('answers failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, {
        status: 200,
        body: { order: CUSTOMER_ORDER },
      });
      expect(await fetchCustomerOrder(TOKEN, fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});

describe.each([
  ['confirmCustomerOrder', confirmCustomerOrder, 'confirm'],
  ['declineCustomerOrder', declineCustomerOrder, 'decline'],
  ['cancelCustomerOrder', cancelCustomerOrder, 'cancel'],
] as const)('%s', (_name, press, action) => {
  it(`posts to /api/o/:token/${action} with the token encoded and no body`, async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { order: CUSTOMER_ORDER } });

    await press(ODD_TOKEN, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/o/${ODD_TOKEN_IN_PATH}/${action}`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toBeUndefined();
  });
});

describe('updateCustomerOrder', () => {
  it('patches /api/o/:token with the token encoded and the request as JSON', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: { order: CUSTOMER_ORDER } });

    await updateCustomerOrder(ODD_TOKEN, CUSTOMER_UPDATE, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/o/${ODD_TOKEN_IN_PATH}`);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(jsonBodyOf(calls[0])).toEqual(CUSTOMER_UPDATE);
  });
});

/** One of the four writes of the customer's page, called with a fake fetch. */
interface CustomerWrite {
  name: string;
  write: (fetchFn: FetchFn) => Promise<CustomerOrderWriteOutcome>;
}

/** The four writes answer alike: every route's success is a 200 with the order as it is now. */
const CUSTOMER_WRITES: CustomerWrite[] = [
  { name: 'confirmCustomerOrder', write: (fetchFn) => confirmCustomerOrder(TOKEN, fetchFn) },
  { name: 'declineCustomerOrder', write: (fetchFn) => declineCustomerOrder(TOKEN, fetchFn) },
  { name: 'cancelCustomerOrder', write: (fetchFn) => cancelCustomerOrder(TOKEN, fetchFn) },
  {
    name: 'updateCustomerOrder',
    write: (fetchFn) => updateCustomerOrder(TOKEN, CUSTOMER_UPDATE, fetchFn),
  },
];

describe.each(CUSTOMER_WRITES)('$name answers', ({ write }) => {
  it('saved with the stored order on 200', async () => {
    const confirmed: CustomerOrder = { ...CUSTOMER_ORDER, status: 'confirmed' };
    const { fetchFn } = makeFakeFetch({ status: 200, body: { order: confirmed } });

    expect(await write(fetchFn)).toEqual({ kind: 'saved', order: confirmed });
  });

  it('failed on a 200 whose body is not an order', async () => {
    for (const answer of NOT_A_CUSTOMER_ORDER) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it("closed with the spec's words on a 409 confirmations_closed, not the body's", async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'confirmations_closed', message: 'anything' },
    });

    expect(await write(fetchFn)).toEqual({
      kind: 'closed',
      message: 'האישור נסגר. נחזור אליך עם מועד חדש.',
    });
  });

  it('closed with the shared message on a 409 invalid_transition', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'invalid_transition', message: 'anything' },
    });

    expect(await write(fetchFn)).toEqual({
      kind: 'closed',
      message: 'ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.',
    });
  });

  it('failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'duplicate_open_order', message: 'x' } },
      { status: 409, body: { message: 'x' } },
      { status: 409, body: ['confirmations_closed'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('invalid on a 400, each message next to its field', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: {
        error: 'invalid_order',
        fieldErrors: { bottlesEstimated: 'צריך לפחות 30 בקבוקים', 'address.houseNumber': 'x' },
      },
    });

    expect(await write(fetchFn)).toEqual({
      kind: 'invalid',
      errors: { byField: { bottlesEstimated: 'צריך לפחות 30 בקבוקים', houseNumber: 'x' } },
    });
  });

  it('invalid with a message above the form on a 400 without usable field errors', async () => {
    for (const answer of [
      // A body refused as a whole (a `contact` key, nothing to change) has no field to show it.
      { status: 400, body: { error: 'invalid_order', fieldErrors: {} } },
      { status: 400, body: { error: 'invalid_json' } },
      { status: 400, text: 'Bad Request' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'invalid',
        errors: { byField: {}, other: UNKNOWN_FIELD_ERROR },
      });
    }
  });

  it('notFound on 404, whatever the body says', async () => {
    for (const answer of [
      { status: 404, body: { error: 'order_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'notFound' });
    }
  });

  it('failed on any other status, without a retry', async () => {
    for (const status of [201, 204, 401, 403, 413, 429, 500, 502, 503]) {
      const { fetchFn, calls } = makeFakeFetch(
        status === 204 ? { status, noBody: true } : { status, body: { order: CUSTOMER_ORDER } },
        { status: 200, body: { order: CUSTOMER_ORDER } },
      );
      expect(await write(fetchFn), String(status)).toEqual({ kind: 'failed' });
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('failed after a network error or a fetch that throws, with exactly one call', async () => {
    for (const answer of ['networkError', 'throws'] as const) {
      const { fetchFn, calls } = makeFakeFetch(answer, {
        status: 200,
        body: { order: CUSTOMER_ORDER },
      });
      expect(await write(fetchFn), answer).toEqual({ kind: 'failed' });
      expect(calls, answer).toHaveLength(1);
    }
  });
});
