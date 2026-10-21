// Acceptance tests of /api/collector/orders (spec §3.5: the "הזמנות" screen) through supertest
// against createApp(fakes): no listen(), no port, no database, no network. Each test keeps the
// in-memory orders repo it passes in, seeds it with makeNewOrder, and reads back what the routes
// stored. Requests carry a valid session cookie (the collector is logged in), and every request
// that changes something comes from the site's own origin (SAME_ORIGIN_HEADERS), as the web app's
// does, except in the guard's and the Origin check's own tests.
import { inspect } from 'node:util';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  COLLECTOR_ORDER_MESSAGES,
  CREATE_ORDER_MESSAGES,
  ORDER_FORM_ERRORS,
  ORDER_STATUSES,
  STREETS,
  collectorOrderResponseSchema,
  collectorOrdersResponseSchema,
  messageOpenedResponseSchema,
  toCollectorOrder,
  type AddOrderRequest,
  type CollectorOrder,
  type CollectorOrdersResponse,
  type MessageLogEntry,
  type NewOrder,
  type Order,
  type Street,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import { createApp } from '../app.ts';
import { loggedInCookie } from '../auth/testSession.ts';
import { createFakeAuth, createFakeDeps } from '../fakeDeps.ts';
import { SAME_ORIGIN_HEADERS, TEST_HOST } from '../testRequest.ts';
import { InMemoryOrdersRepo } from './inMemoryOrdersRepo.ts';
import { MADE_ORDER_CREATED_AT, makeNewOrder } from './makeOrder.ts';

const BASE = '/api/collector/orders';
/** Shaped like a Mongo ObjectId, but no order has it. */
const UNKNOWN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MALFORMED_ID = 'not-an-order-id';

// The customer's data. Distinctive values, so "the log does not contain it" cannot pass or fail
// by accident. Phones start 054, never the 050 of makeNewOrder's phones.
const NAME = 'רבקה לוינסון';
const PHONE = '054-7654321';
const PHONE_DIGITS = '0547654321';
const PHONE_E164 = '+972547654321';
const HOUSE_NUMBER = '17ב';

/** The first street of the real list that matches, or a failed test if there is none. */
function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}

const hasPoint = (street: Street): boolean => street.lat !== undefined && street.lng !== undefined;

/** A listed street in רמת בית שמש, with a map point. */
const RAMAT_STREET = firstRealStreet((street) => street.region === 'ramat' && hasPoint(street));
/** A listed street in the old city, with a map point. */
const OLD_STREET = firstRealStreet((street) => street.region === 'old' && hasPoint(street));

/** A stored address on a listed street. */
function listedAddress(street: Street): Order['address'] {
  return {
    streetCode: street.code,
    streetName: street.name,
    houseNumber: '7',
    bottlesSpot: 'buildingEntrance',
  };
}

/** A free-text street ("הרחוב שלי לא ברשימה"): no code, so no region and no map point. */
const FREE_TEXT_ADDRESS: Order['address'] = {
  streetName: 'הרחוב החדש שלי',
  houseNumber: '12',
  bottlesSpot: 'privateHouse',
};

// Entries of an order's message log (ADR-0003), for the "opened" route.
const MESSAGE_AT = new Date('2026-11-01T09:00:00.000Z');
/** A wa.me link of a confirmation request, not opened yet. */
const MANUAL_CONFIRM: MessageLogEntry = {
  kind: 'confirmRequest',
  at: MESSAGE_AT,
  mode: 'manual',
  url: 'https://wa.me/972547654321?text=confirm',
};
/** A wa.me link of a thank-you, not opened yet. */
const MANUAL_THANKS: MessageLogEntry = {
  kind: 'thankYou',
  at: MESSAGE_AT,
  mode: 'manual',
  url: 'https://wa.me/972547654321?text=thanks',
};
/** A message sent automatically: it has no link to open. */
const SENT_ENTRY: MessageLogEntry = {
  kind: 'confirmRequest',
  at: MESSAGE_AT,
  mode: 'sent',
  providerId: 'wamid.HBgM',
};
/** A message the sender failed on: no link either. */
const FAILED_ENTRY: MessageLogEntry = {
  kind: 'confirmRequest',
  at: MESSAGE_AT,
  mode: 'failed',
  reason: 'invalid_phone',
};

/** A valid "הוספת הזמנה" body, as the web form sends it: a listed street in רמת בית שמש. */
function addBody(overrides: Partial<AddOrderRequest> = {}): AddOrderRequest {
  return {
    contact: { name: NAME, phone: PHONE },
    address: {
      streetCode: RAMAT_STREET.code,
      houseNumber: HOUSE_NUMBER,
      bottlesSpot: 'privateHouse',
    },
    bottlesEstimated: '45',
    ...overrides,
  };
}

let orders: InMemoryOrdersRepo;
let app: Express;
let cookie: string;
let consoleError: MockInstance<typeof console.error>;
let consoleSpies: MockInstance<typeof console.error>[];

beforeEach(() => {
  orders = new InMemoryOrdersRepo();
  // The fake login on the real clock, and a session issued now: valid, and too new to renew.
  const auth = createFakeAuth();
  app = createApp(createFakeDeps({ orders, auth }));
  cookie = loggedInCookie(auth, new Date());
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleSpies = [
    consoleError,
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Another app on `repo`, with its own fake login. Replaces the test's `cookie` with one signed for
 * that login, so the request helpers below work against the returned app.
 */
function appWithRepo(repo: InMemoryOrdersRepo): Express {
  const auth = createFakeAuth();
  cookie = loggedInCookie(auth, new Date());
  return createApp(createFakeDeps({ orders: repo, auth }));
}

/** Stores a made order (see makeNewOrder) and returns it with its id. */
function seed(overrides: Partial<NewOrder> = {}): Promise<Order> {
  return orders.create(makeNewOrder(overrides));
}

/** The stored order with this id; fails the test when there is none. */
async function stored(id: string): Promise<Order> {
  const order = await orders.findById(id);
  if (order === null) throw new Error('no stored order has this id');
  return order;
}

/** Logged-in requests, as the collector app sends them. */
function getList(target: Express = app): request.Test {
  return request(target).get(BASE).set('Cookie', cookie);
}

function getOne(id: string): request.Test {
  return request(app).get(`${BASE}/${id}`).set('Cookie', cookie);
}

function patchOrder(id: string, body: object, target: Express = app): request.Test {
  return request(target)
    .patch(`${BASE}/${id}`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie)
    .send(body);
}

function cancelOrder(id: string, target: Express = app): request.Test {
  return request(target)
    .post(`${BASE}/${id}/cancel`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
}

/** Yoel's "שלח" button: marks the entry at `index` of the order's message log as opened. */
function markOpened(id: string, index: string | number, target: Express = app): request.Test {
  return request(target)
    .post(`${BASE}/${id}/messages/${index}/opened`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
}

function addOrder(body: object): request.Test {
  return request(app).post(BASE).set(SAME_ORIGIN_HEADERS).set('Cookie', cookie).send(body);
}

/** The order in a 200/201 body, checked against the shared contract the web app parses it with. */
function orderOf(res: request.Response): CollectorOrder {
  return collectorOrderResponseSchema.parse(res.body).order;
}

/** The body of GET /, checked against the shared contract. */
function listOf(res: request.Response): CollectorOrdersResponse {
  return collectorOrdersResponseSchema.parse(res.body);
}

/** The ids of the orders in the group `key` of a GET / answer. */
function groupIds(list: CollectorOrdersResponse, key: string): string[] {
  return list.groups.find((group) => group.key === key)?.orders.map((order) => order.id) ?? [];
}

/** Expects the 409 of a status that does not allow the change. */
function expectInvalidTransition(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'invalid_transition',
    message: COLLECTOR_ORDER_MESSAGES.orderClosed,
  });
}

/** Expects the 409 of a phone that already has an open order: the fixed message only. */
function expectDuplicateOpenOrder(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'duplicate_open_order',
    message: CREATE_ORDER_MESSAGES.duplicateOpenOrder,
  });
}

/** Everything written to any console method, objects included in full, for "not in the log". */
function allLogText(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg: unknown) => (typeof arg === 'string' ? arg : inspect(arg, { depth: null })))
    .join('\n');
}

/**
 * An in-memory repo where the order changes under the route: every `findById` hands out the
 * order as it was, then marks it collected, as if Yoel tapped "אספתי" on another screen between
 * the route's read and its write.
 */
class OrdersRepoCollectingOnRead extends InMemoryOrdersRepo {
  override async findById(id: string): Promise<Order | null> {
    const order = await super.findById(id);
    if (order !== null) {
      const now = new Date();
      await super.update(id, { status: 'collected', collectedAt: now, updatedAt: now });
    }
    return order;
  }
}

describe('GET /api/collector/orders: the waiting orders by region', () => {
  it('lists only waiting orders, in the three groups, with counts and bottle totals', async () => {
    const ramatNewer = await seed({
      address: listedAddress(RAMAT_STREET),
      region: 'ramat',
      bottlesEstimated: 40,
      createdAt: new Date('2026-10-18T10:00:00.000Z'),
    });
    const ramatOlder = await seed({
      address: listedAddress(RAMAT_STREET),
      region: 'ramat',
      bottlesEstimated: 60,
      createdAt: new Date('2026-10-17T10:00:00.000Z'),
    });
    const old = await seed({
      address: listedAddress(OLD_STREET),
      region: 'old',
      bottlesEstimated: 35,
    });
    const lastMiss = { date: '2026-10-12', reason: 'notConfirmed', roundId: 'round-1' } as const;
    const noRegion = await seed({ address: FREE_TEXT_ADDRESS, bottlesEstimated: 50, lastMiss });
    // Not waiting: none of these is listed.
    const notListed = await Promise.all(
      (['pending', 'confirmed', 'collected', 'cancelled'] as const).map((status) =>
        seed({ status, address: listedAddress(RAMAT_STREET), region: 'ramat' }),
      ),
    );

    const res = await getList();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = listOf(res);
    expect(
      list.groups.map(({ key, orderCount, bottlesTotal }) => ({ key, orderCount, bottlesTotal })),
    ).toStrictEqual([
      { key: 'ramat', orderCount: 2, bottlesTotal: 100 },
      { key: 'old', orderCount: 1, bottlesTotal: 35 },
      { key: 'none', orderCount: 1, bottlesTotal: 50 },
    ]);
    // Oldest first inside a group.
    expect(groupIds(list, 'ramat')).toStrictEqual([ramatOlder.id, ramatNewer.id]);
    expect(groupIds(list, 'old')).toStrictEqual([old.id]);
    expect(groupIds(list, 'none')).toStrictEqual([noRegion.id]);

    const listed = list.groups.flatMap((group) => group.orders);
    expect(listed.find((order) => order.id === noRegion.id)).toMatchObject({
      lastMiss,
      hasLocation: false,
    });
    expect(listed.find((order) => order.id === ramatOlder.id)?.hasLocation).toBe(true);
    expect(listed.find((order) => order.id === ramatOlder.id)).not.toHaveProperty('lastMiss');
    for (const order of notListed) expect(res.text).not.toContain(order.id);
  });

  it('sends each order as toCollectorOrder makes it: no token, no message log, no contact method', async () => {
    const order = await seed({
      address: listedAddress(OLD_STREET),
      region: 'old',
      messages: [
        {
          kind: 'confirmRequest',
          at: MADE_ORDER_CREATED_AT,
          mode: 'manual',
          url: 'https://wa.me/972500000000?text=secret-message-text',
        },
      ],
    });

    const res = await getList();

    expect(listOf(res).groups[1]?.orders).toStrictEqual([toCollectorOrder(order)]);
    // The raw JSON, not the parsed one: parsing strips unknown keys and would hide a leak.
    const raw = (res.body as { groups: { orders: Record<string, unknown>[] }[] }).groups[1]
      ?.orders[0];
    expect(raw).not.toHaveProperty('token');
    expect(raw).not.toHaveProperty('messages');
    expect(raw?.contact).not.toHaveProperty('method');
    expect(res.text).not.toContain(order.token);
    expect(res.text).not.toContain('secret-message-text');
  });

  it('answers the three groups, empty, when no order is waiting', async () => {
    await seed({ status: 'collected' });

    const res = await getList();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      groups: [
        { key: 'ramat', orderCount: 0, bottlesTotal: 0, orders: [] },
        { key: 'old', orderCount: 0, bottlesTotal: 0, orders: [] },
        { key: 'none', orderCount: 0, bottlesTotal: 0, orders: [] },
      ],
    });
  });
});

describe('GET /api/collector/orders/:id', () => {
  it('answers one order, whatever its status, without its token', async () => {
    const order = await seed({ status: 'collected', collectedAt: MADE_ORDER_CREATED_AT });

    const res = await getOne(order.id);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(orderOf(res)).toStrictEqual(toCollectorOrder(order));
    expect(res.text).not.toContain(order.token);
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers 404 order_not_found for $label', async ({ id }) => {
    await seed();

    const res = await getOne(id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
  });
});

describe('PATCH /api/collector/orders/:id: a near street ("רחוב קרוב")', () => {
  it('on a free-text order sets the near street, its region and a map point, and moves it to that group', async () => {
    const order = await seed({ address: FREE_TEXT_ADDRESS });
    expect(groupIds(listOf(await getList()), 'none')).toStrictEqual([order.id]);

    const res = await patchOrder(order.id, { nearStreetCode: OLD_STREET.code });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const answered = orderOf(res);
    expect(answered.address).toStrictEqual({
      ...FREE_TEXT_ADDRESS,
      nearStreetCode: OLD_STREET.code,
    });
    expect(answered.region).toBe('old');
    expect(answered.hasLocation).toBe(true);
    expect(answered).toStrictEqual(toCollectorOrder(await stored(order.id)));

    const list = listOf(await getList());
    expect(groupIds(list, 'old')).toStrictEqual([order.id]);
    expect(groupIds(list, 'none')).toStrictEqual([]);
  });
});

describe('PATCH /api/collector/orders/:id: editing', () => {
  it('changes contact, address and bottles, keeping the contact method', async () => {
    const order = await seed({ address: listedAddress(RAMAT_STREET), region: 'ramat' });
    const body: UpdateOrderRequest = {
      contact: { name: ` ${NAME} `, phone: PHONE },
      address: {
        streetCode: RAMAT_STREET.code,
        houseNumber: HOUSE_NUMBER,
        bottlesSpot: 'apartmentDoor',
        floorApt: 'קומה 2, דירה 4',
      },
      bottlesEstimated: '80',
    };

    const res = await patchOrder(order.id, body);

    expect(res.status).toBe(200);
    const after = await stored(order.id);
    expect(after).toMatchObject({
      contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
      address: {
        streetCode: RAMAT_STREET.code,
        streetName: RAMAT_STREET.name,
        houseNumber: HOUSE_NUMBER,
        bottlesSpot: 'apartmentDoor',
        floorApt: 'קומה 2, דירה 4',
      },
      bottlesEstimated: 80,
      region: 'ramat',
      status: 'waiting',
      token: order.token,
      createdAt: order.createdAt,
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(order.updatedAt.getTime());
    expect(orderOf(res)).toStrictEqual(toCollectorOrder(after));
  });

  it('sets an explicit region ("שינוי אזור"), and the order is listed in it', async () => {
    const order = await seed({ address: listedAddress(RAMAT_STREET), region: 'ramat' });

    const res = await patchOrder(order.id, { region: 'old' });

    expect(res.status).toBe(200);
    expect(orderOf(res).region).toBe('old');
    expect((await stored(order.id)).region).toBe('old');
    expect(groupIds(listOf(await getList()), 'old')).toStrictEqual([order.id]);
  });

  it.each(['pending', 'confirmed'] as const)(
    'edits an order that is %s (still open)',
    async (status) => {
      const order = await seed({ status });

      const res = await patchOrder(order.id, { bottlesEstimated: 33 });

      expect(res.status).toBe(200);
      expect(await stored(order.id)).toMatchObject({ status, bottlesEstimated: 33 });
    },
  );

  it('refuses 19 bottles with 400 and the plain message, changing nothing', async () => {
    const order = await seed();

    const res = await patchOrder(order.id, { bottlesEstimated: 19 });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'invalid_order',
      fieldErrors: { bottlesEstimated: ORDER_FORM_ERRORS.bottlesTooFew },
    });
    expect(await stored(order.id)).toStrictEqual(order);
  });

  it.each([
    { label: 'a status (a PATCH never changes it)', body: { status: 'collected' } },
    { label: 'an unknown key next to a valid one', body: { bottlesEstimated: 40, token: 'x' } },
    { label: 'nothing to change', body: {} },
  ])('refuses $label with 400 and no field errors', async ({ body }) => {
    const order = await seed();

    const res = await patchOrder(order.id, body);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_order', fieldErrors: {} });
    expect(await stored(order.id)).toStrictEqual(order);
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers 404 order_not_found for $label', async ({ id }) => {
    const res = await patchOrder(id, { bottlesEstimated: 40 });

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
  });

  it.each(['collected', 'cancelled'] as const)(
    'refuses to edit an order that is %s with 409 invalid_transition',
    async (status) => {
      const order = await seed({ status });

      const res = await patchOrder(order.id, { bottlesEstimated: 99 });

      expectInvalidTransition(res);
      expect(await stored(order.id)).toStrictEqual(order);
    },
  );

  it('answers 409 invalid_transition when the order was collected between the read and the write', async () => {
    const racing = new OrdersRepoCollectingOnRead();
    const order = await racing.create(makeNewOrder());
    const racingApp = appWithRepo(racing);

    const res = await patchOrder(order.id, { bottlesEstimated: 99 }, racingApp);

    expectInvalidTransition(res);
    expect((await racing.findById(order.id))?.bottlesEstimated).toBe(order.bottlesEstimated);
  });

  it('refuses a phone that another open order has with 409 duplicate_open_order, changing nothing', async () => {
    const other = await seed({
      contact: { name: 'משה כהן', phone: PHONE_E164, method: 'whatsapp' },
    });
    const order = await seed();

    const res = await patchOrder(order.id, { contact: { name: NAME, phone: '+972 54-765-4321' } });

    expectDuplicateOpenOrder(res);
    expect(res.text).not.toContain(other.id);
    expect(res.text).not.toContain(other.token);
    expect(await stored(order.id)).toStrictEqual(order);
  });
});

describe('POST /api/collector/orders/:id/cancel', () => {
  it('cancels a waiting order: status, cancelledAt and updatedAt set to now', async () => {
    const order = await seed();
    const before = Date.now();

    const res = await cancelOrder(order.id);

    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const cancelled = await stored(order.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(cancelled.cancelledAt?.getTime()).toBeLessThanOrEqual(after);
    expect(cancelled.updatedAt).toEqual(cancelled.cancelledAt);
    expect(orderOf(res)).toStrictEqual(toCollectorOrder(cancelled));
    // A cancelled order is no longer listed.
    expect(res.text).not.toContain(order.token);
    expect(listOf(await getList()).groups.every((group) => group.orderCount === 0)).toBe(true);
  });

  it('cancels an order in a round and leaves its round as it is', async () => {
    const order = await seed({ status: 'pending', roundId: 'round-7' });

    const res = await cancelOrder(order.id);

    expect(res.status).toBe(200);
    expect(await stored(order.id)).toMatchObject({ status: 'cancelled', roundId: 'round-7' });
  });

  it('answers a repeated cancel with 200 and writes nothing again', async () => {
    const order = await seed();
    expect((await cancelOrder(order.id)).status).toBe(200);
    const first = await stored(order.id);

    const res = await cancelOrder(order.id);

    expect(res.status).toBe(200);
    expect(orderOf(res).status).toBe('cancelled');
    expect(await stored(order.id)).toStrictEqual(first);
  });

  it('refuses to cancel a collected order with 409 invalid_transition, changing nothing', async () => {
    const order = await seed({ status: 'collected', collectedAt: MADE_ORDER_CREATED_AT });

    const res = await cancelOrder(order.id);

    expectInvalidTransition(res);
    expect(await stored(order.id)).toStrictEqual(order);
  });

  it('answers 409 invalid_transition when the order was collected between the read and the write', async () => {
    const racing = new OrdersRepoCollectingOnRead();
    const order = await racing.create(makeNewOrder());

    const res = await cancelOrder(order.id, appWithRepo(racing));

    expectInvalidTransition(res);
    expect((await racing.findById(order.id))?.status).toBe('collected');
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers 404 order_not_found for $label', async ({ id }) => {
    const res = await cancelOrder(id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
  });
});

describe('POST /api/collector/orders/:id/messages/:index/opened', () => {
  it('sets openedAt of the manual entry to now, changing nothing else, the status included', async () => {
    const order = await seed({
      status: 'pending',
      roundId: 'round-7',
      messages: [FAILED_ENTRY, MANUAL_CONFIRM],
    });
    const before = Date.now();

    const res = await markOpened(order.id, 1);

    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { openedAt } = messageOpenedResponseSchema.parse(res.body);
    expect(openedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(openedAt.getTime()).toBeLessThanOrEqual(after);
    expect(await stored(order.id)).toStrictEqual({
      ...order,
      messages: [FAILED_ENTRY, { ...MANUAL_CONFIRM, openedAt }],
      updatedAt: openedAt,
    });
    // Only the moment: no order, no link, no customer data in the answer.
    expect(Object.keys(res.body as object)).toEqual(['openedAt']);
  });

  it.each([...ORDER_STATUSES])(
    'works on a %s order and leaves its status as it is',
    async (status) => {
      // A thank-you is opened after "אספתי", when the order is already collected.
      const order = await seed({ status, messages: [MANUAL_CONFIRM, MANUAL_THANKS] });

      const res = await markOpened(order.id, 1);

      expect(res.status).toBe(200);
      const after = await stored(order.id);
      expect(after.status).toBe(status);
      expect(after.messages[0]).toStrictEqual(MANUAL_CONFIRM);
      expect(after.messages[1]).toStrictEqual({
        ...MANUAL_THANKS,
        openedAt: messageOpenedResponseSchema.parse(res.body).openedAt,
      });
    },
  );

  it('answers an entry opened before with its first openedAt, writing nothing', async () => {
    const firstOpenedAt = new Date('2026-11-01T09:05:00.000Z');
    const order = await seed({ messages: [{ ...MANUAL_CONFIRM, openedAt: firstOpenedAt }] });

    const res = await markOpened(order.id, 0);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ openedAt: firstOpenedAt.toISOString() });
    expect(await stored(order.id)).toStrictEqual(order);
  });

  it('answers a second tap with the openedAt of the first, writing nothing again', async () => {
    const order = await seed({ messages: [MANUAL_CONFIRM] });
    const first = await markOpened(order.id, 0);
    const afterFirst = await stored(order.id);

    const second = await markOpened(order.id, 0);

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual(first.body);
    expect(await stored(order.id)).toStrictEqual(afterFirst);
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers 404 order_not_found for $label', async ({ id }) => {
    const res = await markOpened(id, 0);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
  });

  it.each([
    { label: 'an index past the end', index: '3' },
    { label: 'a negative index', index: '-1' },
    { label: 'a signed index', index: '+2' },
    { label: 'a decimal index', index: '1.5' },
    { label: 'an exponent', index: '2e0' },
    { label: 'an index that is not a number', index: 'abc' },
    { label: 'a sent entry, which has no link', index: '0' },
    { label: 'a failed entry, which has no link', index: '1' },
  ])('answers 404 message_not_found for $label, changing nothing', async ({ index }) => {
    const order = await seed({ messages: [SENT_ENTRY, FAILED_ENTRY, MANUAL_CONFIRM] });

    const res = await markOpened(order.id, index);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'message_not_found' });
    expect(await stored(order.id)).toStrictEqual(order);
  });

  it('answers 404 message_not_found for an order with no messages', async () => {
    const order = await seed();

    const res = await markOpened(order.id, 0);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'message_not_found' });
  });

  it('answers 404 order_not_found when the order is gone by the time it is written', async () => {
    const vanishing = new InMemoryOrdersRepo();
    const order = await vanishing.create(makeNewOrder({ messages: [MANUAL_CONFIRM] }));
    vi.spyOn(vanishing, 'update').mockResolvedValue(null);

    const res = await markOpened(order.id, 0, appWithRepo(vanishing));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
  });
});

describe('POST /api/collector/orders: "הוספת הזמנה"', () => {
  it('stores a waiting order from the collector, with the region of its street, and answers 201', async () => {
    const res = await addOrder(addBody());

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const answered = orderOf(res);
    const created = await stored(answered.id);
    expect(created).toMatchObject({
      source: 'collector',
      status: 'waiting',
      region: 'ramat',
      contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
      address: {
        streetCode: RAMAT_STREET.code,
        streetName: RAMAT_STREET.name,
        houseNumber: HOUSE_NUMBER,
        bottlesSpot: 'privateHouse',
      },
      bottlesEstimated: 45,
      messages: [],
    });
    expect(answered).toStrictEqual(toCollectorOrder(created));
    expect(answered.hasLocation).toBe(true);
    expect(res.text).not.toContain(created.token);
  });

  it('stores the order even with a filled `website` key: no honeypot behind the login', async () => {
    const res = await addOrder({ ...addBody(), website: 'https://spam.example' });

    expect(res.status).toBe(201);
    expect(await orders.list()).toHaveLength(1);
    expect(await stored(orderOf(res).id)).not.toHaveProperty('website');
  });

  it.each([PHONE, '+972 54-765-4321', '00972547654321'])(
    'refuses a phone that already has an open order, typed as %s, with 409',
    async (phone) => {
      const existing = await seed({
        status: 'confirmed',
        contact: { name: 'משה כהן', phone: PHONE_E164, method: 'whatsapp' },
      });

      const res = await addOrder(addBody({ contact: { name: NAME, phone } }));

      expectDuplicateOpenOrder(res);
      expect(res.text).not.toContain(existing.token);
      expect(await orders.list()).toHaveLength(1);
    },
  );

  it('refuses 19 bottles with 400 and the plain message, storing nothing', async () => {
    const res = await addOrder(addBody({ bottlesEstimated: 19 }));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'invalid_order',
      fieldErrors: { bottlesEstimated: ORDER_FORM_ERRORS.bottlesTooFew },
    });
    expect(await orders.list()).toEqual([]);
  });

  it('refuses an empty form with 400, a message for each missing field', async () => {
    const res = await addOrder({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'invalid_order',
      fieldErrors: { bottlesEstimated: ORDER_FORM_ERRORS.bottlesRequired },
    });
    expect(await orders.list()).toEqual([]);
  });

  it('answers no body with 400 invalid_order and no field errors', async () => {
    const res = await request(app).post(BASE).set(SAME_ORIGIN_HEADERS).set('Cookie', cookie);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_order', fieldErrors: {} });
  });

  it('is not rate-limited: 12 orders in a row are all stored', async () => {
    for (let sent = 0; sent < 12; sent += 1) {
      const phone = `058-00000${String(sent).padStart(2, '0')}`;
      expect((await addOrder(addBody({ contact: { name: NAME, phone } }))).status).toBe(201);
    }

    expect(await orders.list()).toHaveLength(12);
  });
});

describe('/api/collector/orders: the login and the Origin check', () => {
  it.each([
    { label: 'GET /', send: () => request(app).get(BASE) },
    { label: 'GET /:id', send: () => request(app).get(`${BASE}/${UNKNOWN_ID}`) },
    {
      label: 'PATCH /:id',
      send: () => request(app).patch(`${BASE}/${UNKNOWN_ID}`).send({ bottlesEstimated: 40 }),
    },
    { label: 'POST /:id/cancel', send: () => request(app).post(`${BASE}/${UNKNOWN_ID}/cancel`) },
    {
      label: 'POST /:id/messages/:index/opened',
      send: () => request(app).post(`${BASE}/${UNKNOWN_ID}/messages/0/opened`),
    },
    { label: 'POST /', send: () => request(app).post(BASE).send(addBody()) },
  ])('answers $label without a session cookie with 401, changing nothing', async ({ send }) => {
    const order = await seed();

    // From the site itself, so it is the login guard answering, not the Origin check.
    const res = await send().set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
    expect(await orders.list()).toStrictEqual([order]);
  });

  it('applies the guard to an existing order too: 401 without a cookie reveals nothing', async () => {
    const order = await seed();

    const res = await request(app).get(`${BASE}/${order.id}`).set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(401);
    expect(res.text).not.toContain(order.contact.phone);
  });

  it('refuses a PATCH from another site with 403 forbidden_origin, even with the cookie', async () => {
    const order = await seed();

    const res = await request(app)
      .patch(`${BASE}/${order.id}`)
      .set('Host', TEST_HOST)
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .send({ region: 'old' });

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(await stored(order.id)).toStrictEqual(order);
  });

  it('refuses "opened" from another site with 403 forbidden_origin, even with the cookie', async () => {
    const order = await seed({ messages: [MANUAL_CONFIRM] });

    const res = await request(app)
      .post(`${BASE}/${order.id}/messages/0/opened`)
      .set('Host', TEST_HOST)
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(await stored(order.id)).toStrictEqual(order);
  });
});

describe('/api/collector/orders: logs', () => {
  it('log nothing, whatever the answer', async () => {
    const other = await seed({
      contact: { name: 'משה כהן', phone: PHONE_E164, method: 'whatsapp' },
    });
    const order = await seed({ address: FREE_TEXT_ADDRESS });
    const messaged = await seed({ messages: [MANUAL_CONFIRM] });

    const statuses = [
      (await getList()).status,
      (await getOne(order.id)).status,
      (await getOne(UNKNOWN_ID)).status,
      (await patchOrder(order.id, { nearStreetCode: RAMAT_STREET.code })).status,
      (await patchOrder(order.id, { bottlesEstimated: 19 })).status,
      (await patchOrder(order.id, { contact: { name: NAME, phone: PHONE } })).status,
      (await addOrder(addBody())).status,
      (await cancelOrder(other.id)).status,
      (await cancelOrder(other.id)).status,
      (await markOpened(messaged.id, 0)).status,
      (await markOpened(messaged.id, 0)).status,
      (await markOpened(messaged.id, 1)).status,
      (await markOpened(UNKNOWN_ID, 0)).status,
    ];

    expect(statuses).toEqual([200, 200, 404, 200, 400, 409, 409, 200, 200, 200, 200, 404, 404]);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('answer 500 when the repo fails, logging none of the customer data its error quotes', async () => {
    // A database error whose message quotes the customer's data, like a Mongo E11000 does.
    const failing = new InMemoryOrdersRepo();
    const order = await failing.create(makeNewOrder());
    vi.spyOn(failing, 'update').mockRejectedValue(
      new Error(`E11000 duplicate key: { phone: "${PHONE_E164}" } ${NAME} ${HOUSE_NUMBER}`),
    );

    const res = await patchOrder(
      order.id,
      {
        contact: { name: NAME, phone: PHONE },
        address: { ...FREE_TEXT_ADDRESS, houseNumber: HOUSE_NUMBER },
      },
      appWithRepo(failing),
    );

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: 'internal' });
    // The 500 was logged, so the check below reads a real log line, not an empty log.
    expect(consoleError).toHaveBeenCalled();
    const logText = allLogText();
    for (const secret of [PHONE, PHONE_DIGITS, PHONE_E164, NAME, HOUSE_NUMBER]) {
      expect(logText).not.toContain(secret);
    }
  });
});
