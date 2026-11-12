import { describe, expect, it } from 'vitest';
import type { CreateOrderRequest, CreateOrderResponse } from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import { createOrder } from './bookingApi.ts';
import { makeFakeFetch } from './fakeFetch.ts';
import { describeEveryEndpoint } from './request.contract.ts';

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

describeEveryEndpoint([
  {
    name: 'createOrder',
    call: (fetchFn) => createOrder(REQUEST, fetchFn),
    success: { status: 201, body: CREATED },
    on401: 'failed',
    alsoFailed: [404, 413],
    networkTries: 2,
  },
]);
