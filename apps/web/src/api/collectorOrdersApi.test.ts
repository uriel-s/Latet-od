import { describe, expect, it } from 'vitest';
import {
  COLLECTOR_ORDER_MESSAGES,
  type AddOrderRequest,
  type OrderGroup,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import {
  addCollectorOrder,
  cancelCollectorOrder,
  deleteCollectorOrder,
  fetchCollectorOrder,
  fetchWaitingOrders,
  markMessageOpened,
  updateCollectorOrder,
  type CollectorOrderWriteOutcome,
} from './collectorOrdersApi.ts';
import { jsonBodyOf, makeFakeFetch } from './fakeFetch.ts';
import type { FetchFn } from './request.ts';
import { describeEveryEndpoint, type EndpointCase } from './request.contract.ts';
import { ODD_ID, ODD_ID_IN_PATH, ORDER } from './testFixtures.ts';

/** The three groups of the "הזמנות" screen, as GET /api/collector/orders answers them. */
const GROUPS: OrderGroup[] = [
  { key: 'ramat', orderCount: 1, bottlesTotal: 45, orders: [ORDER] },
  { key: 'old', orderCount: 0, bottlesTotal: 0, orders: [] },
  { key: 'none', orderCount: 0, bottlesTotal: 0, orders: [] },
];

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

describeEveryEndpoint([
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
]);
