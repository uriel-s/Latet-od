import { describe, expect, it } from 'vitest';
import type { CustomerOrder, CustomerUpdateOrderRequest } from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import {
  cancelCustomerOrder,
  declineCustomerOrder,
  fetchCustomerOrder,
  updateCustomerOrder,
  type CustomerOrderWriteOutcome,
} from './customerOrderApi.ts';
import { jsonBodyOf, makeFakeFetch } from './fakeFetch.ts';
import type { FetchFn } from './request.ts';
import { describeEveryEndpoint, type EndpointCase } from './request.contract.ts';

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

describeEveryEndpoint(
  [
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
  ],
  [TOKEN],
);
