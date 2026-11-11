import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { COLLECTOR_ORDER_MESSAGES } from '@bottlerun/shared';
import type {
  AddOrderRequest,
  CollectorOrder,
  CreateOrderRequest,
  CreateOrderResponse,
  CustomerOrder,
  CustomerUpdateOrderRequest,
  HistoryResponse,
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
  closeRound,
  collectStop,
  createOrder,
  declineCustomerOrder,
  deleteCollectorOrder,
  deletePushSubscription,
  fetchCollectorOrder,
  fetchCustomerOrder,
  fetchHistory,
  fetchPushConfig,
  fetchRounds,
  fetchSession,
  fetchWaitingOrders,
  login,
  logout,
  markMessageOpened,
  markStopNotFound,
  moveStop,
  planRound,
  savePushSubscription,
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
        fieldErrors: { bottlesEstimated: 'צריך לפחות 20 בקבוקים', 'address.streetCode': 'x' },
      },
    });

    expect(await createOrder(REQUEST, fetchFn)).toEqual({
      kind: 'invalid',
      errors: { byField: { bottlesEstimated: 'צריך לפחות 20 בקבוקים', street: 'x' } },
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

describe('deleteCollectorOrder', () => {
  it('sends DELETE to /api/collector/orders/:id with the id encoded and no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 204, noBody: true });

    await deleteCollectorOrder(ODD_ID, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/orders/${ODD_ID_IN_PATH}`);
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('answers deleted on 204', async () => {
    const { fetchFn } = makeFakeFetch({ status: 204, noBody: true });

    expect(await deleteCollectorOrder(ORDER.id, fetchFn)).toEqual({ kind: 'deleted' });
  });

  it('answers deleted on 404 too: the order is already gone, which is what was asked', async () => {
    const { fetchFn } = makeFakeFetch({ status: 404, body: { error: 'order_not_found' } });

    expect(await deleteCollectorOrder(ORDER.id, fetchFn)).toEqual({ kind: 'deleted' });
  });

  it('answers refused with the plain-Hebrew reason on 409 cannot_delete', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'cannot_delete', message: 'x' },
    });

    expect(await deleteCollectorOrder(ORDER.id, fetchFn)).toEqual({
      kind: 'refused',
      message: COLLECTOR_ORDER_MESSAGES.cannotDelete,
    });
  });

  it('answers failed on a 409 it does not know, so it never guesses a reason', async () => {
    const { fetchFn } = makeFakeFetch({ status: 409, body: { error: 'other' } });

    expect(await deleteCollectorOrder(ORDER.id, fetchFn)).toEqual({ kind: 'failed' });
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
});

// ---------------------------------------------------------------------------------------------
// The collector's rounds: /api/collector/rounds
// ---------------------------------------------------------------------------------------------

/**
 * A planned round with one order in it and its "שלח" row, as the api answers it. JSON.stringify
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
    { key: 'inRound', orders: [{ ...ORDER, status: 'confirmed' }] },
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
    expect(outcome.rounds[0]?.groups[0]?.orders[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('carries previousPickupFrom next to previousPickupBy', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 200,
      body: { ...ROUNDS, previousPickupFrom: '07:00' },
    });

    const outcome = await fetchRounds(fetchFn);

    expect(outcome).toEqual({
      kind: 'loaded',
      rounds: [ROUND_VIEW],
      previousPickupBy: '08:30',
      previousPickupFrom: '07:00',
    });
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
});

/** What the planning screen sends: a pickup time, and its personal text as typed. */
const PLAN: PlanRoundRequest = {
  date: '2026-11-12',
  region: 'ramat',
  orderIds: [ORDER.id, '6710f3a2c4b5d6e7f8a9b0c9'],
  pickupBy: '08:00',
  personalText: 'תודה רבה!',
};

describe('planRound', () => {
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
    { key: 'inRound', orders: [{ ...ORDER, status: 'collected' }, SECOND_ORDER] },
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
      message: 'המסלול של הסבב הזה כבר נבנה, או שהסבב נסגר. נא לרענן את המסך.',
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

/**
 * The routed round once Yoel tapped "סיימתי את הסבב": closed, with `closedAt`. Its second stop was not
 * reached, so that order is back in `waiting` and the stop shows `left`.
 */
const CLOSED_VIEW: RoundView = {
  ...ROUTED_VIEW,
  round: {
    ...ROUTED_VIEW.round,
    status: 'closed',
    closedAt: new Date('2026-11-12T15:30:00.000Z'),
  },
  stops: [
    ROUTED_VIEW.stops[0]!,
    {
      order: {
        ...SECOND_ORDER,
        status: 'waiting',
        lastMiss: { date: '2026-11-12', reason: 'notReached', roundId: ROUND_VIEW.round.id },
      },
      hasLocation: false,
      state: 'left',
    },
  ],
};

describe('closeRound', () => {
  it('posts to /api/collector/rounds/:id/close, the id encoded, no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: CLOSED_VIEW });

    await closeRound(ODD_ID, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/rounds/${ODD_ID_IN_PATH}/close`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('answers closed with the closed view on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: CLOSED_VIEW });

    const outcome = await closeRound(ROUND_VIEW.round.id, fetchFn);

    expect(outcome).toEqual({ kind: 'closed', view: CLOSED_VIEW });
    if (outcome.kind !== 'closed') throw new Error('expected closed');
    expect(outcome.view.round.closedAt).toBeInstanceOf(Date);
    expect(outcome.view.stops[1]?.order.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUTED_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await closeRound(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
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
      expect(await closeRound(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'notFound',
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The collector's history: GET /api/collector/history?month=
// ---------------------------------------------------------------------------------------------

/** October 2026: one collected order and one cancelled one, newest first. */
const HISTORY: HistoryResponse = {
  month: '2026-10',
  totals: { bottlesCollected: 45, addressesCollected: 1, valueAgorot: 900 },
  orders: [
    {
      id: 'o2',
      status: 'cancelled',
      contact: { name: 'משה לוי' },
      address: { streetName: 'הרצל', houseNumber: '5' },
      bottlesEstimated: 40,
      closedAt: new Date('2026-10-20T09:00:00.000Z'),
    },
    {
      id: 'o1',
      status: 'collected',
      contact: { name: 'דנה כהן' },
      address: { streetName: 'שד נהר הדן', houseNumber: '12' },
      bottlesEstimated: 40,
      bottlesCollected: 45,
      closedAt: new Date('2026-10-12T07:30:00.000Z'),
    },
  ],
};

describe('fetchHistory', () => {
  it('asks GET /api/collector/history with the month, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: HISTORY });

    await fetchHistory('2026-10', fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/history?month=2026-10');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('encodes the month, so it stays one query value', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 400, body: { error: 'invalid_month' } });

    await fetchHistory('2026-10&month=2026-11', fetchFn);

    expect(calls[0]?.input).toBe('/api/collector/history?month=2026-10%26month%3D2026-11');
  });

  it('answers loaded with the totals and the closed orders on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: HISTORY });

    const outcome = await fetchHistory('2026-10', fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', history: HISTORY });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.history.orders[0]?.closedAt).toBeInstanceOf(Date);
  });

  it('answers loaded for a month with nothing closed', async () => {
    const empty: HistoryResponse = {
      month: '2026-09',
      totals: { bottlesCollected: 0, addressesCollected: 0, valueAgorot: 0 },
      orders: [],
    };
    const { fetchFn } = makeFakeFetch({ status: 200, body: empty });

    expect(await fetchHistory('2026-09', fetchFn)).toEqual({ kind: 'loaded', history: empty });
  });

  it('answers failed on a 200 whose body is not a history', async () => {
    const [firstOrder] = HISTORY.orders;
    for (const answer of [
      { status: 200, body: { ...HISTORY, month: '2026-13' } },
      { status: 200, body: { ...HISTORY, totals: { ...HISTORY.totals, valueAgorot: -1 } } },
      { status: 200, body: { ...HISTORY, orders: [{ ...firstOrder, status: 'waiting' }] } },
      { status: 200, body: { ...HISTORY, orders: [{ ...firstOrder, closedAt: 'yesterday' }] } },
      { status: 200, body: { totals: HISTORY.totals, orders: [] } },
      { status: 200, body: [] },
      { status: 200, text: '<html>ok</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchHistory('2026-10', fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
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

/** An order of the customer's page in a round, with its round's date and pickup time. */
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
  status: 'confirmed',
  lang: 'he',
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
});

describe.each([
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

/** One of the three writes of the customer's page, called with a fake fetch. */
interface CustomerWrite {
  name: string;
  write: (fetchFn: FetchFn) => Promise<CustomerOrderWriteOutcome>;
}

/** The three writes answer alike: every route's success is a 200 with the order as it is now. */
const CUSTOMER_WRITES: CustomerWrite[] = [
  { name: 'declineCustomerOrder', write: (fetchFn) => declineCustomerOrder(TOKEN, fetchFn) },
  { name: 'cancelCustomerOrder', write: (fetchFn) => cancelCustomerOrder(TOKEN, fetchFn) },
  {
    name: 'updateCustomerOrder',
    write: (fetchFn) => updateCustomerOrder(TOKEN, CUSTOMER_UPDATE, fetchFn),
  },
];

describe.each(CUSTOMER_WRITES)('$name answers', ({ write }) => {
  it('saved with the stored order on 200', async () => {
    const stored: CustomerOrder = { ...CUSTOMER_ORDER, bottlesEstimated: 60 };
    const { fetchFn } = makeFakeFetch({ status: 200, body: { order: stored } });

    expect(await write(fetchFn)).toEqual({ kind: 'saved', order: stored });
  });

  it('failed on a 200 whose body is not an order', async () => {
    for (const answer of NOT_A_CUSTOMER_ORDER) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await write(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
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
      // Only the customer's confirm, gone since ADR-0012, answered this one: no words for it now.
      { status: 409, body: { error: 'confirmations_closed', message: 'x' } },
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
        fieldErrors: { bottlesEstimated: 'צריך לפחות 20 בקבוקים', 'address.houseNumber': 'x' },
      },
    });

    expect(await write(fetchFn)).toEqual({
      kind: 'invalid',
      errors: { byField: { bottlesEstimated: 'צריך לפחות 20 בקבוקים', houseNumber: 'x' } },
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
});

describe('fetchPushConfig', () => {
  it('asks GET /api/collector/push/config, past browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({
      status: 200,
      body: { enabled: true, publicKey: 'test-key' },
    });
    const outcome = await fetchPushConfig(fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/push/config');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(outcome).toEqual({
      kind: 'loaded',
      config: { enabled: true, publicKey: 'test-key' },
    });
  });

  it('answers loaded with disabled config', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 200,
      body: { enabled: false },
    });
    const outcome = await fetchPushConfig(fetchFn);
    expect(outcome).toEqual({
      kind: 'loaded',
      config: { enabled: false },
    });
  });

  it('answers failed on invalid 200 or 500', async () => {
    const { fetchFn: invalid200 } = makeFakeFetch({ status: 200, body: { enabled: true } });
    expect(await fetchPushConfig(invalid200)).toEqual({ kind: 'failed' });

    const { fetchFn: serverError } = makeFakeFetch({ status: 500, body: { error: 'internal' } });
    expect(await fetchPushConfig(serverError)).toEqual({ kind: 'failed' });
  });
});

describe('savePushSubscription', () => {
  const subscription = {
    endpoint: 'https://push.example/sub1',
    keys: { p256dh: 'p256dhKey', auth: 'authKey' },
  };

  it('sends POST /api/collector/push/subscribe and answers saved on 204', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 204, noBody: true });
    const outcome = await savePushSubscription(subscription, fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/push/subscribe');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify(subscription));
    expect(outcome).toEqual({ kind: 'saved' });
  });
});

describe('deletePushSubscription', () => {
  it('sends POST /api/collector/push/unsubscribe and answers deleted on 204', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 204, noBody: true });
    const outcome = await deletePushSubscription('https://push.example/sub1', fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/push/unsubscribe');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ endpoint: 'https://push.example/sub1' }));
    expect(outcome).toEqual({ kind: 'deleted' });
  });
});

// ---------------------------------------------------------------------------------------------
// What every endpoint answers alike, because request() decides it once for all of them
// ---------------------------------------------------------------------------------------------

/** One endpoint, called the way its screen calls it. */
interface EndpointCase {
  name: string;
  /** Calls the endpoint. logout's boolean becomes `cleared` / `failed`, so every row reads alike. */
  call: (fetchFn: FetchFn) => Promise<{ kind: string }>;
  /** An answer it succeeds with: queued after a failing one, it would show a retry. */
  success: FakeAnswer;
  /**
   * What a 401 answers: `loggedOut` behind the login, `failed` on a public route, or null when the
   * endpoint gives it a meaning of its own (login: the wrong password, tested with login).
   */
  on401: 'loggedOut' | 'failed' | null;
  /** Statuses `failed` for this endpoint, on top of {@link ALWAYS_FAILED}. */
  alsoFailed: number[];
  /** The body of those failing answers, when it matters that it would look like a success's. */
  failedBody?: unknown;
  /** How many fetches a network error costs: 2 for the booking form, which retries once. */
  networkTries?: number;
}

/** Statuses no endpoint knows: each answers `failed`, without a retry. */
const ALWAYS_FAILED = [403, 500, 502, 503];

const PUSH_ENDPOINT = 'https://push.example/sub1';

const ENDPOINTS: EndpointCase[] = [
  {
    name: 'createOrder',
    call: (fetchFn) => createOrder(REQUEST, fetchFn),
    success: { status: 201, body: CREATED },
    on401: 'failed',
    alsoFailed: [404, 413],
    networkTries: 2,
  },
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
    alsoFailed: [],
  },
  {
    name: 'fetchWaitingOrders',
    call: (fetchFn) => fetchWaitingOrders(fetchFn),
    success: { status: 200, body: { groups: GROUPS } },
    on401: 'loggedOut',
    alsoFailed: [404, 429],
  },
  {
    name: 'fetchCollectorOrder',
    call: (fetchFn) => fetchCollectorOrder(ORDER.id, fetchFn),
    success: { status: 200, body: { order: ORDER } },
    on401: 'loggedOut',
    alsoFailed: [400, 409],
  },
  ...WRITES.map(({ name, successStatus, write }): EndpointCase => ({
    name,
    call: write,
    success: { status: successStatus, body: { order: ORDER } },
    on401: 'loggedOut',
    alsoFailed: [413, 429],
  })),
  {
    name: 'deleteCollectorOrder',
    call: (fetchFn) => deleteCollectorOrder(ORDER.id, fetchFn),
    success: { status: 204, noBody: true },
    on401: 'loggedOut',
    alsoFailed: [400, 429],
    failedBody: { error: 'forbidden_origin' },
  },
  {
    name: 'markMessageOpened',
    call: (fetchFn) => markMessageOpened(ORDER.id, 0, fetchFn),
    success: { status: 200, body: { openedAt: OPENED_AT } },
    on401: 'loggedOut',
    alsoFailed: [201, 400, 409, 429],
  },
  {
    name: 'fetchRounds',
    call: (fetchFn) => fetchRounds(fetchFn),
    success: { status: 200, body: { rounds: [ROUND_VIEW] } },
    on401: 'loggedOut',
    alsoFailed: [201, 404, 429],
    failedBody: { rounds: [ROUND_VIEW] },
  },
  {
    name: 'planRound',
    call: (fetchFn) => planRound(PLAN, fetchFn),
    success: { status: 201, body: ROUND_VIEW },
    on401: 'loggedOut',
    alsoFailed: [404, 413, 429],
  },
  {
    name: 'buildRoute',
    call: (fetchFn) => buildRoute(ROUND_VIEW.round.id, fetchFn),
    success: { status: 200, body: ROUTED_VIEW },
    on401: 'loggedOut',
    alsoFailed: [201, 400, 429],
  },
  ...STOP_ACTIONS.map(({ name, act }): EndpointCase => ({
    name,
    call: (fetchFn) => act(ROUND_VIEW.round.id, ORDER.id, fetchFn),
    success: { status: 200, body: ROUTED_VIEW },
    on401: 'loggedOut',
    alsoFailed: [201, 429],
  })),
  {
    name: 'closeRound',
    call: (fetchFn) => closeRound(ROUND_VIEW.round.id, fetchFn),
    success: { status: 200, body: CLOSED_VIEW },
    on401: 'loggedOut',
    // The route has no 409: even a known code there is from something in between.
    alsoFailed: [201, 400, 409, 429],
    failedBody: { error: 'confirmations_closed' },
  },
  {
    name: 'fetchHistory',
    call: (fetchFn) => fetchHistory('2026-10', fetchFn),
    success: { status: 200, body: HISTORY },
    on401: 'loggedOut',
    // A 400 too: the picker only builds valid months, so `invalid_month` is a client bug.
    alsoFailed: [201, 400, 404, 429],
    failedBody: { error: 'invalid_month' },
  },
  {
    name: 'fetchCustomerOrder',
    call: (fetchFn) => fetchCustomerOrder(TOKEN, fetchFn),
    success: { status: 200, body: { order: CUSTOMER_ORDER } },
    on401: 'failed',
    alsoFailed: [201, 400, 409, 429],
  },
  ...CUSTOMER_WRITES.map(({ name, write }): EndpointCase => ({
    name,
    call: write,
    success: { status: 200, body: { order: CUSTOMER_ORDER } },
    on401: 'failed',
    // A success status other than the route's own (200) means nothing the page can show.
    alsoFailed: [201, 204, 413, 429],
    failedBody: { order: CUSTOMER_ORDER },
  })),
  {
    name: 'fetchPushConfig',
    call: (fetchFn) => fetchPushConfig(fetchFn),
    success: { status: 200, body: { enabled: true, publicKey: 'test-key' } },
    on401: 'loggedOut',
    alsoFailed: [404, 429],
  },
  {
    name: 'savePushSubscription',
    call: (fetchFn) =>
      savePushSubscription(
        { endpoint: PUSH_ENDPOINT, keys: { p256dh: 'p256dhKey', auth: 'authKey' } },
        fetchFn,
      ),
    success: { status: 204, noBody: true },
    on401: 'loggedOut',
    alsoFailed: [400, 429],
  },
  {
    name: 'deletePushSubscription',
    call: (fetchFn) => deletePushSubscription(PUSH_ENDPOINT, fetchFn),
    success: { status: 204, noBody: true },
    on401: 'loggedOut',
    alsoFailed: [400, 429],
  },
];

/** An answer with `status` and `body`; a 204 has none, since a Response cannot carry one. */
function answerWith(status: number, body: unknown): FakeAnswer {
  return status === 204 ? { status, noBody: true } : { status, body };
}

/**
 * A fetch whose answer breaks as it is read: a stand-in for any bug past the network, which the
 * endpoint must log and answer as `failed` instead of rejecting.
 */
const brokenAnswerFetch: FetchFn = () =>
  Promise.resolve({
    get status(): number {
      throw new Error('broken answer');
    },
  } as unknown as Response);

describe('every endpoint', () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it.each(ENDPOINTS.filter(({ on401 }) => on401 !== null))(
    '$name answers $on401 on 401, whatever the body says',
    async ({ call, on401 }) => {
      for (const answer of [
        { status: 401, body: { error: 'unauthenticated' } },
        { status: 401, text: 'Unauthorized' },
      ]) {
        const { fetchFn, calls } = makeFakeFetch(answer);
        expect(await call(fetchFn), JSON.stringify(answer)).toEqual({ kind: on401 });
        expect(calls).toHaveLength(1);
      }
    },
  );

  it.each(ENDPOINTS)(
    '$name answers failed on any other status, without a retry',
    async ({ call, success, alsoFailed, failedBody = { error: 'x' } }) => {
      for (const status of [...ALWAYS_FAILED, ...alsoFailed]) {
        const { fetchFn, calls } = makeFakeFetch(answerWith(status, failedBody), success);
        expect(await call(fetchFn), String(status)).toEqual({ kind: 'failed' });
        expect(calls, String(status)).toHaveLength(1);
      }
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it.each(ENDPOINTS)(
    '$name answers failed after a network error or a fetch that throws, without logging',
    async ({ call, success, networkTries = 1 }) => {
      for (const answer of ['networkError', 'throws'] as const) {
        const answers: FakeAnswer[] = Array.from({ length: networkTries }, () => answer);
        const { fetchFn, calls } = makeFakeFetch(...answers, success);
        expect(await call(fetchFn), answer).toEqual({ kind: 'failed' });
        expect(calls, answer).toHaveLength(networkTries);
      }
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it.each(ENDPOINTS)(
    '$name logs an unexpected error, without the request, and answers failed',
    async ({ call }) => {
      expect(await call(brokenAnswerFetch)).toEqual({ kind: 'failed' });

      expect(consoleError).toHaveBeenCalledTimes(1);
      // Never the body (a phone, an address, a password) or the path (it can hold a token).
      const logged = consoleError.mock.calls.flat().map(String).join(' ');
      for (const secret of ['/api/', '+97250', 'דרך רבין', PASSWORD.trim(), TOKEN]) {
        expect(logged).not.toContain(secret);
      }
    },
  );
});
