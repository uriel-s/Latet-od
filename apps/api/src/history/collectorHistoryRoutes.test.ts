// Acceptance tests of GET /api/collector/history (spec §3.7: the "היסטוריה" screen) through
// supertest against createApp(fakes): no listen(), no port, no database, no network. Each test
// seeds the in-memory orders repo it passes in with makeNewOrder, closed (collected or cancelled)
// at chosen instants, and reads the month's answer. Requests carry a valid session cookie (the
// collector is logged in), except in the guard's own test.
import { inspect } from 'node:util';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  historyResponseSchema,
  type HistoryResponse,
  type NewOrder,
  type Order,
} from '@bottlerun/shared';
import { createApp } from '../app.ts';
import { loggedInCookie } from '../auth/testSession.ts';
import { createFakeAuth, createFakeDeps } from '../fakeDeps.ts';
import { InMemoryOrdersRepo } from '../orders/inMemoryOrdersRepo.ts';
import { makeNewOrder } from '../orders/makeOrder.ts';
import { SAME_ORIGIN_HEADERS } from '../testRequest.ts';

const BASE = '/api/collector/history';

// The last night of October in Israel. Summer time ends on the last Sunday of October (25/10 in
// 2026), so 31/10/2026 is UTC+2: 23:30 Israel is 21:30 UTC, and 00:30 on 1/11 Israel is 22:30 UTC
// on 31/10. The same UTC day, two different months.
const OCT_31_2330_ISRAEL = new Date('2026-10-31T21:30:00.000Z');
const NOV_1_0030_ISRAEL = new Date('2026-10-31T22:30:00.000Z');
const MID_OCTOBER = new Date('2026-10-15T09:00:00.000Z');

let orders: InMemoryOrdersRepo;
let app: Express;
let cookie: string;
let consoleSpies: MockInstance<typeof console.error>[];

beforeEach(() => {
  orders = new InMemoryOrdersRepo();
  // The fake login on the real clock, and a session issued now: valid, and too new to renew.
  const auth = createFakeAuth();
  app = createApp(createFakeDeps({ orders, auth }));
  cookie = loggedInCookie(auth, new Date());
  consoleSpies = [
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An order Yoel collected at `collectedAt`, with `bottlesCollected` recorded on "אספתי". */
function seedCollected(
  collectedAt: Date,
  bottlesCollected: number,
  overrides: Partial<NewOrder> = {},
): Promise<Order> {
  return orders.create(
    makeNewOrder({ status: 'collected', collectedAt, bottlesCollected, ...overrides }),
  );
}

/** An order cancelled at `cancelledAt`. */
function seedCancelled(cancelledAt: Date, overrides: Partial<NewOrder> = {}): Promise<Order> {
  return orders.create(makeNewOrder({ status: 'cancelled', cancelledAt, ...overrides }));
}

/** GET the history of `month` as the logged-in collector. */
function getMonth(month: string): request.Test {
  return request(app).get(BASE).query({ month }).set('Cookie', cookie);
}

/** The history of `month`, after checking the answer is a 200 that matches the shared contract. */
async function historyOf(month: string): Promise<HistoryResponse> {
  const res = await getMonth(month);
  expect(res.status).toBe(200);
  return historyResponseSchema.parse(res.body);
}

/** The ids of a history's orders, in the order listed. */
function idsOf(history: HistoryResponse): string[] {
  return history.orders.map((order) => order.id);
}

/** Everything written to any console method, objects included in full. */
function allLogText(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg: unknown) => (typeof arg === 'string' ? arg : inspect(arg, { depth: null })))
    .join('\n');
}

describe('GET /api/collector/history', () => {
  it('answers the month, its totals and its closed orders, newest first', async () => {
    const older = await seedCollected(MID_OCTOBER, 45);
    const newer = await seedCollected(OCT_31_2330_ISRAEL, 30);

    const res = await getMonth('2026-10');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = historyResponseSchema.parse(res.body);
    expect(body.month).toBe('2026-10');
    expect(idsOf(body)).toStrictEqual([newer.id, older.id]);
    expect(body.orders[0]).toStrictEqual({
      id: newer.id,
      status: 'collected',
      contact: { name: newer.contact.name },
      address: { streetName: newer.address.streetName, houseNumber: newer.address.houseNumber },
      bottlesEstimated: newer.bottlesEstimated,
      bottlesCollected: 30,
      closedAt: OCT_31_2330_ISRAEL,
    });
  });

  it('counts the value in whole agorot: 45 + 30 bottles collected is 1500 agorot', async () => {
    await seedCollected(MID_OCTOBER, 45);
    await seedCollected(OCT_31_2330_ISRAEL, 30);

    const history = await historyOf('2026-10');

    expect(history.totals).toStrictEqual({
      bottlesCollected: 75,
      addressesCollected: 2,
      valueAgorot: 1500,
    });
  });

  it('counts an order collected at 23:30 on 31/10 Israel time in October, not November', async () => {
    const lastNight = await seedCollected(OCT_31_2330_ISRAEL, 40);

    const october = await historyOf('2026-10');
    const november = await historyOf('2026-11');

    expect(idsOf(october)).toStrictEqual([lastNight.id]);
    expect(october.totals.bottlesCollected).toBe(40);
    expect(idsOf(november)).toStrictEqual([]);
    expect(november.totals.bottlesCollected).toBe(0);
  });

  it('counts an order collected at 00:30 on 1/11 Israel time in November, not October', async () => {
    const firstNight = await seedCollected(NOV_1_0030_ISRAEL, 35);

    const october = await historyOf('2026-10');
    const november = await historyOf('2026-11');

    expect(idsOf(october)).toStrictEqual([]);
    expect(october.totals.bottlesCollected).toBe(0);
    expect(idsOf(november)).toStrictEqual([firstNight.id]);
    expect(november.totals.bottlesCollected).toBe(35);
  });

  it('answers an empty month with zeros and an empty list', async () => {
    await seedCollected(MID_OCTOBER, 45);

    const res = await getMonth('2026-09');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      month: '2026-09',
      totals: { bottlesCollected: 0, addressesCollected: 0, valueAgorot: 0 },
      orders: [],
    });
  });

  it('lists a cancelled order but counts it in none of the totals', async () => {
    const collected = await seedCollected(MID_OCTOBER, 45);
    const cancelled = await seedCancelled(OCT_31_2330_ISRAEL, { bottlesEstimated: 200 });

    const body = await historyOf('2026-10');

    expect(body.totals).toStrictEqual({
      bottlesCollected: 45,
      addressesCollected: 1,
      valueAgorot: 900,
    });
    expect(body.orders.map(({ id, status }) => ({ id, status }))).toStrictEqual([
      { id: cancelled.id, status: 'cancelled' },
      { id: collected.id, status: 'collected' },
    ]);
    expect(body.orders[0]).not.toHaveProperty('bottlesCollected');
    expect(body.orders[0]?.closedAt).toStrictEqual(OCT_31_2330_ISRAEL);
  });

  it('leaves out the orders still open, whenever they were created or updated', async () => {
    await orders.create(makeNewOrder({ status: 'waiting', updatedAt: MID_OCTOBER }));
    await orders.create(
      makeNewOrder({ status: 'pending', roundId: 'round-1', updatedAt: MID_OCTOBER }),
    );
    await orders.create(
      makeNewOrder({ status: 'confirmed', roundId: 'round-1', updatedAt: MID_OCTOBER }),
    );

    const history = await historyOf('2026-10');

    expect(history.orders).toStrictEqual([]);
    expect(history.totals.addressesCollected).toBe(0);
  });

  it('never sends a phone or a token, and logs nothing', async () => {
    const collected = await seedCollected(MID_OCTOBER, 45);
    const cancelled = await seedCancelled(MID_OCTOBER);

    const res = await getMonth('2026-10');

    expect(res.status).toBe(200);
    for (const order of [collected, cancelled]) {
      expect(res.text).not.toContain(order.contact.phone);
      expect(res.text).not.toContain(order.token);
    }
    expect(res.text).not.toContain('"phone"');
    expect(res.text).not.toContain('"token"');
    expect(allLogText()).toBe('');
  });

  it.each([
    { label: 'a missing month', query: '' },
    { label: 'month 13', query: '?month=2026-13' },
    { label: 'a one-digit month', query: '?month=2026-1' },
    { label: 'month 00', query: '?month=2026-00' },
    { label: 'a full date', query: '?month=2026-10-01' },
    { label: 'an empty month', query: '?month=' },
    { label: 'a repeated month', query: '?month=2026-10&month=2026-11' },
    { label: 'a month in brackets', query: '?month[a]=2026-10' },
  ])('refuses $label with 400 invalid_month', async ({ query }) => {
    await seedCollected(MID_OCTOBER, 45);

    const res = await request(app).get(`${BASE}${query}`).set('Cookie', cookie);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_month' });
  });

  it('answers 401 without a session cookie, revealing nothing', async () => {
    const collected = await seedCollected(MID_OCTOBER, 45);

    // From the site itself, so it is the login guard answering, not the Origin check.
    const res = await request(app).get(BASE).query({ month: '2026-10' }).set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
    expect(res.text).not.toContain(collected.contact.name);
  });
});
