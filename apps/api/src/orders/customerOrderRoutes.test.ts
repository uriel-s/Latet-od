// Acceptance tests of /api/o/:token, the customer's own page (spec §3.3), through supertest against
// createApp(fakes): no listen(), no port, no database, no network. Each test keeps the in-memory
// repos it passes in, seeds them with makeNewOrder / makeNewRound, and reads back what the routes
// stored. The routes are public: no session cookie, except where a test looks at Yoel's side of
// the same order (his round view, his orders screen, planning a new round). Every POST and PATCH
// comes from the site's own origin (SAME_ORIGIN_HEADERS), as the web page's does, except in the
// Origin check's own test.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  CUSTOMER_ORDER_MESSAGES,
  ORDER_FORM_ERRORS,
  STREETS,
  collectorOrdersResponseSchema,
  customerOrderResponseSchema,
  roundViewSchema,
  type CustomerOrder,
  type CustomerUpdateOrderRequest,
  type MessageLogEntry,
  type NewOrder,
  type NewRound,
  type Order,
  type OrderGroupKey,
  type OrderStatus,
  type Round,
  type RoundGroupKey,
  type RoundView,
  type Street,
} from '@bottlerun/shared';
import { createApp } from '../app.ts';
import { loggedInCookie } from '../auth/testSession.ts';
import { createFakeAuth, createFakeDeps } from '../fakeDeps.ts';
import { InMemoryRoundsRepo } from '../rounds/inMemoryRoundsRepo.ts';
import { makeNewRound } from '../rounds/makeRound.ts';
import { SAME_ORIGIN_HEADERS, TEST_HOST } from '../testRequest.ts';
import { InMemoryOrdersRepo } from './inMemoryOrdersRepo.ts';
import { makeNewOrder } from './makeOrder.ts';
import type { OrderPatch, OrderUpdateOptions } from './ordersRepo.ts';

const BASE = '/api/o';

/** Well-formed (43 base64url characters), but no order has it. */
const UNKNOWN_TOKEN = 'unknown-token-'.padEnd(43, '0');
/** Not tokens at all: too short, the right length with a character base64url has no, too long. */
const MALFORMED_TOKENS = ['abc', `${'a'.repeat(42)}!`, 'a'.repeat(44)];

/** The three buttons of the page, by their path. */
const ACTIONS = ['confirm', 'decline', 'cancel'] as const;
type Action = (typeof ACTIONS)[number];

// The round Yoel planned.
const DATE = '2026-11-12';
const PICKUP_BY = '08:00';

// A customer's data. Distinctive values, so "the log does not contain it" cannot pass or fail by
// accident. The phone starts 054, never the 050 of makeNewOrder's phones.
const NAME = 'רבקה לוינסון';
const PHONE_E164 = '+972547654321';
const STREET_NAME = 'רחוב הדקל המיוחד';
const HOUSE_NUMBER = '17ב';
const FLOOR_APT = 'קומה 3, דירה 12';
const NOTE = 'ליד העגלה הכחולה';

/** The order's confirmation request, already sent as a wa.me link (ADR-0003). */
const MANUAL_REQUEST_URL = 'https://wa.me/972547654321?text=secret-confirm-link';
const MANUAL_REQUEST: MessageLogEntry = {
  kind: 'confirmRequest',
  at: new Date('2026-11-10T17:00:00.000Z'),
  mode: 'manual',
  url: MANUAL_REQUEST_URL,
};

/** Shaped like a Mongo ObjectId: an earlier round the order once left. */
const EARLIER_ROUND_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

/** The first street of the real list that matches, or a failed test if there is none. */
function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}

/** A listed street in רמת בית שמש. */
const RAMAT_STREET = firstRealStreet((street) => street.region === 'ramat');
/** A listed street in the old city. */
const OLD_STREET = firstRealStreet((street) => street.region === 'old');

/** An address as the page's change form sends it (before validation). */
type AddressRequest = NonNullable<CustomerUpdateOrderRequest['address']>;

/** A stored address on {@link RAMAT_STREET}, the bottles at the apartment door. */
const RAMAT_ADDRESS: Order['address'] = {
  streetCode: RAMAT_STREET.code,
  streetName: RAMAT_STREET.name,
  houseNumber: '7',
  bottlesSpot: 'apartmentDoor',
  floorApt: FLOOR_APT,
  note: NOTE,
};
/** {@link RAMAT_ADDRESS} as the change form sends it: the code, no name (the api sets it). */
const RAMAT_INPUT: AddressRequest = {
  streetCode: RAMAT_STREET.code,
  houseNumber: '7',
  bottlesSpot: 'apartmentDoor',
  floorApt: FLOOR_APT,
  note: NOTE,
};
/** A move to a listed street of the old city. */
const OLD_INPUT: AddressRequest = {
  streetCode: OLD_STREET.code,
  houseNumber: '3',
  bottlesSpot: 'privateHouse',
};
/** {@link OLD_INPUT} as stored: with the street's official name. */
const OLD_ADDRESS: Order['address'] = {
  streetCode: OLD_STREET.code,
  streetName: OLD_STREET.name,
  houseNumber: '3',
  bottlesSpot: 'privateHouse',
};

/** A free-text street with Yoel's near street ("רחוב קרוב", ADR-0005) in רמת בית שמש. */
const FREE_TEXT_WITH_NEAR: Order['address'] = {
  streetName: STREET_NAME,
  nearStreetCode: RAMAT_STREET.code,
  houseNumber: HOUSE_NUMBER,
  bottlesSpot: 'privateHouse',
};
/** {@link FREE_TEXT_WITH_NEAR} as the change form sends it: never a near street. */
const FREE_TEXT_INPUT: AddressRequest = {
  streetName: STREET_NAME,
  houseNumber: HOUSE_NUMBER,
  bottlesSpot: 'privateHouse',
};

/** A change the PATCH accepts, for the tests about everything but the change. */
const VALID_UPDATE: CustomerUpdateOrderRequest = { bottlesEstimated: 50 };

/**
 * An in-memory orders repo where someone else changes the order at the worst moment: just before
 * a route's conditional write (`ifStatus`) to an id in {@link racesBeforeConditionalWrite}, the
 * next patch queued for it is applied, so the write may find another status and answer null.
 * Unconditional writes go through as usual.
 */
class RacingOrdersRepo extends InMemoryOrdersRepo {
  /** Per order id, the changes made by "someone else", one before each conditional write. */
  readonly racesBeforeConditionalWrite = new Map<string, OrderPatch[]>();

  override async update(
    id: string,
    patch: OrderPatch,
    options?: OrderUpdateOptions,
  ): Promise<Order | null> {
    const race =
      options?.ifStatus === undefined
        ? undefined
        : this.racesBeforeConditionalWrite.get(id)?.shift();
    if (race !== undefined) await super.update(id, race);
    return super.update(id, patch, options);
  }
}

/** Yoel's cancel landing first. */
const CANCELLED_MEANWHILE: OrderPatch = {
  status: 'cancelled',
  cancelledAt: new Date('2026-11-11T10:00:00.000Z'),
  updatedAt: new Date('2026-11-11T10:00:00.000Z'),
};
/** "אישר בטלפון", or the customer's other tap, landing first. */
const CONFIRMED_MEANWHILE: OrderPatch = {
  status: 'confirmed',
  updatedAt: new Date('2026-11-11T10:00:00.000Z'),
};

let orders: InMemoryOrdersRepo;
let rounds: InMemoryRoundsRepo;
let app: Express;
/** A logged-in collector's cookie, for Yoel's side of the same order. */
let cookie: string;
let consoleSpies: MockInstance<typeof console.error>[];

/**
 * Builds the test's app on fresh repos (or on `options.orders`), with its own fake login and a
 * session issued now. Seed AFTER calling it: it replaces the module's `orders` and `rounds`.
 */
function buildApp(options: { orders?: InMemoryOrdersRepo } = {}): void {
  orders = options.orders ?? new InMemoryOrdersRepo();
  rounds = new InMemoryRoundsRepo();
  const auth = createFakeAuth();
  app = createApp(createFakeDeps({ orders, rounds, auth }));
  cookie = loggedInCookie(auth, new Date());
}

beforeEach(() => {
  buildApp();
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

/** Stores a made order (see makeNewOrder): `waiting`, in no round, unless overridden. */
function seed(overrides: Partial<NewOrder> = {}): Promise<Order> {
  return orders.create(makeNewOrder(overrides));
}

/**
 * Stores a round (open, confirming, on {@link DATE}, pickup by {@link PICKUP_BY}, unless
 * overridden) and one order in it: `pending`, with its confirmation request in the log, unless
 * overridden. The round's `orderIds` lists the order, as planning leaves it.
 */
async function seedInRound(
  options: { order?: Partial<NewOrder>; round?: Partial<NewRound> } = {},
): Promise<{ order: Order; round: Round }> {
  const created = await rounds.create(
    makeNewRound({ date: DATE, pickupBy: PICKUP_BY, ...options.round }),
  );
  const order = await seed({
    status: 'pending',
    roundId: created.id,
    messages: [MANUAL_REQUEST],
    ...options.order,
  });
  const round = await rounds.update(created.id, { orderIds: [order.id] });
  if (round === null) throw new Error('the round just stored is gone');
  return { order, round };
}

/** The stored order with this id; fails the test when there is none. */
async function storedOrder(id: string): Promise<Order> {
  const order = await orders.findById(id);
  if (order === null) throw new Error('no stored order has this id');
  return order;
}

/** Everything a refused request must leave as it was: every order and every round. */
async function storedState(): Promise<{ orders: Order[]; rounds: Round[] }> {
  return { orders: await orders.list(), rounds: await rounds.list() };
}

/** The customer's page, as the web page loads it (and WhatsApp's link preview). */
function getPage(token: string): request.Test {
  return request(app).get(`${BASE}/${token}`);
}

/** One of the page's buttons, from the site's own origin. */
function press(action: Action, token: string): request.Test {
  return request(app).post(`${BASE}/${token}/${action}`).set(SAME_ORIGIN_HEADERS);
}

/** "שינוי" on the page, from the site's own origin; without `body`, a PATCH with no body. */
function patchOrder(token: string, body?: string | object): request.Test {
  const patch = request(app).patch(`${BASE}/${token}`).set(SAME_ORIGIN_HEADERS);
  return body === undefined ? patch : patch.send(body);
}

/** Yoel's "הזמנות" screen (logged in): the ids of the waiting orders in each region group. */
async function waitingGroups(): Promise<Record<OrderGroupKey, string[]>> {
  const res = await request(app).get('/api/collector/orders').set('Cookie', cookie);
  expect(res.status).toBe(200);
  const { groups } = collectorOrdersResponseSchema.parse(res.body);
  const ids = (key: OrderGroupKey): string[] =>
    groups.find((group) => group.key === key)?.orders.map((order) => order.id) ?? [];
  return { ramat: ids('ramat'), old: ids('old'), none: ids('none') };
}

/** Yoel's view of a round (logged in). */
async function roundView(roundId: string): Promise<RoundView> {
  const res = await request(app).get(`/api/collector/rounds/${roundId}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return roundViewSchema.parse(res.body);
}

/** The three groups of a round view as order ids. */
function groupsOf(view: RoundView): Record<RoundGroupKey, string[]> {
  const ids = (key: RoundGroupKey): string[] =>
    view.groups.find((group) => group.key === key)?.orders.map((order) => order.id) ?? [];
  return { confirmed: ids('confirmed'), pending: ids('pending'), otherDate: ids('otherDate') };
}

/** The order in a 200 body, checked against the shared contract the web page parses. */
function orderOf(res: request.Response): CustomerOrder {
  expect(res.status).toBe(200);
  return customerOrderResponseSchema.parse(res.body).order;
}

/** Expects `date` to be inside [before, after]: a time the route took from the real clock. */
function expectBetween(date: Date | undefined, before: Date, after: Date): void {
  expect(date).toBeInstanceOf(Date);
  expect(date?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(date?.getTime()).toBeLessThanOrEqual(after.getTime());
}

/** Expects the 404 every route answers for an unknown or a malformed token. */
function expectNotFound(res: request.Response): void {
  expect(res.status).toBe(404);
  expect(res.body).toStrictEqual({ error: 'order_not_found' });
  expect(res.headers['cache-control']).toBe('no-store');
}

/** Expects the 409 of a closed order (collected or cancelled), with the customer's message. */
function expectOrderClosed(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'invalid_transition',
    message: CUSTOMER_ORDER_MESSAGES.orderClosed,
  });
  expect(res.headers['cache-control']).toBe('no-store');
}

/** Expects the 409 of a confirm when the round no longer takes confirmations (spec §3.3). */
function expectConfirmationsClosed(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'confirmations_closed',
    message: 'האישור נסגר. נחזור אליך עם מועד חדש.',
  });
  expect(res.headers['cache-control']).toBe('no-store');
}

describe('GET /api/o/:token', () => {
  it('answers 200 with exactly the allow-listed fields, the round date and pickup time, never cached', async () => {
    const { order, round } = await seedInRound({
      order: {
        contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
        address: {
          streetName: STREET_NAME,
          nearStreetCode: 987654,
          houseNumber: HOUSE_NUMBER,
          bottlesSpot: 'apartmentDoor',
          floorApt: FLOOR_APT,
          note: NOTE,
        },
        bottlesEstimated: 55,
        region: 'ramat',
        lastMiss: { date: '2026-10-01', reason: 'notFound', roundId: EARLIER_ROUND_ID },
      },
    });

    const res = await getPage(order.token);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    // The whole body, so no key at any depth can slip in unnoticed.
    expect(res.body).toStrictEqual({
      order: {
        contact: { name: NAME, phone: PHONE_E164 },
        address: {
          streetName: STREET_NAME,
          houseNumber: HOUSE_NUMBER,
          bottlesSpot: 'apartmentDoor',
          floorApt: FLOOR_APT,
          note: NOTE,
        },
        bottlesEstimated: 55,
        status: 'pending',
        round: { date: DATE, pickupBy: PICKUP_BY },
      },
    });
    expect(Object.keys(orderOf(res)).sort()).toStrictEqual(
      ['address', 'bottlesEstimated', 'contact', 'round', 'status'].sort(),
    );
    // Nothing internal, in any form: ids, the token, the message log, the earlier miss.
    for (const secret of [order.id, round.id, order.token, MANUAL_REQUEST_URL, EARLIER_ROUND_ID]) {
      expect(res.text).not.toContain(secret);
    }
  });

  it('shows the round date to a confirmed customer ("נתראה ב-<תאריך>")', async () => {
    const { order } = await seedInRound({ order: { status: 'confirmed' } });

    const page = orderOf(await getPage(order.token));

    expect(page.status).toBe('confirmed');
    expect(page.round).toStrictEqual({ date: DATE, pickupBy: PICKUP_BY });
  });

  it('shows no round for a waiting order', async () => {
    const order = await seed();

    const page = orderOf(await getPage(order.token));

    expect(page.status).toBe('waiting');
    expect(page).not.toHaveProperty('round');
  });

  it('changes nothing: the order, its message log and its round stay exactly as they were', async () => {
    const { order, round } = await seedInRound();
    const before = await storedState();

    // WhatsApp's link preview, then the customer opening the page.
    await getPage(order.token);
    const res = await getPage(order.token);

    expect(res.status).toBe(200);
    expect(await storedState()).toStrictEqual(before);
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('pending');
    expect(stored.updatedAt).toStrictEqual(order.updatedAt);
    expect(stored.messages).toStrictEqual([MANUAL_REQUEST]);
    expect(await rounds.findById(round.id)).toStrictEqual(round);
  });
});

describe('/api/o/:token: unknown and malformed tokens', () => {
  const tokens = [UNKNOWN_TOKEN, ...MALFORMED_TOKENS];

  it('GET answers the identical 404 for an unknown and for each malformed token', async () => {
    await seedInRound();
    const before = await storedState();

    for (const token of tokens) expectNotFound(await getPage(token));

    expect(await storedState()).toStrictEqual(before);
  });

  it.each(ACTIONS)(
    'POST %s answers the identical 404 for an unknown and for each malformed token, changing nothing',
    async (action) => {
      await seedInRound();
      const before = await storedState();

      for (const token of tokens) expectNotFound(await press(action, token));

      expect(await storedState()).toStrictEqual(before);
    },
  );

  it('never asks the database about a malformed token', async () => {
    const findByToken = vi.spyOn(orders, 'findByToken');

    for (const token of MALFORMED_TOKENS) {
      expectNotFound(await getPage(token));
      for (const action of ACTIONS) expectNotFound(await press(action, token));
      expectNotFound(await patchOrder(token, VALID_UPDATE));
    }

    expect(findByToken).not.toHaveBeenCalled();
  });

  it('PATCH with a valid body answers the identical 404 for an unknown, a forged and each malformed token, changing nothing', async () => {
    const { order } = await seedInRound();
    // One character off the real token: well-formed, but no order has it.
    const forged = `${order.token.slice(0, -1)}${order.token.endsWith('X') ? 'Y' : 'X'}`;
    const before = await storedState();

    for (const token of [...tokens, forged]) {
      expectNotFound(await patchOrder(token, VALID_UPDATE));
    }

    expect(await storedState()).toStrictEqual(before);
  });
});

describe('POST /api/o/:token/confirm', () => {
  it('moves a pending order to confirmed and answers it with its round', async () => {
    const { order } = await seedInRound();
    const before = new Date();

    const res = await press('confirm', order.token);

    const after = new Date();
    expect(res.headers['cache-control']).toBe('no-store');
    const page = orderOf(res);
    expect(page.status).toBe('confirmed');
    expect(page.round).toStrictEqual({ date: DATE, pickupBy: PICKUP_BY });
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('confirmed');
    expect(stored.roundId).toBe(order.roundId);
    expectBetween(stored.updatedAt, before, after);
  });

  it('keeps the message log intact', async () => {
    const { order } = await seedInRound();

    await press('confirm', order.token);

    expect((await storedOrder(order.id)).messages).toStrictEqual([MANUAL_REQUEST]);
  });

  it('answers 200 to a double tap, and the second writes nothing', async () => {
    const { order } = await seedInRound();

    const first = await press('confirm', order.token);
    const afterFirst = await storedOrder(order.id);
    const second = await press('confirm', order.token);

    expect(orderOf(first).status).toBe('confirmed');
    expect(orderOf(second).status).toBe('confirmed');
    expect(await storedOrder(order.id)).toStrictEqual(afterFirst);
  });

  it.each([
    { label: 'the route was built (phase routed)', round: { phase: 'routed' } as const },
    { label: 'the round was closed', round: { status: 'closed' } as const },
  ])('answers 409 confirmations_closed when $label, and the order stays pending', async (c) => {
    const { order } = await seedInRound({ round: c.round });
    const before = await storedState();

    const res = await press('confirm', order.token);

    expectConfirmationsClosed(res);
    expect(await storedState()).toStrictEqual(before);
    expect((await storedOrder(order.id)).status).toBe('pending');
  });

  it('answers 409 confirmations_closed for a pending order whose round is missing', async () => {
    const order = await seed({ status: 'pending', roundId: 'cccccccccccccccccccccccc' });

    expectConfirmationsClosed(await press('confirm', order.token));
    expect((await storedOrder(order.id)).status).toBe('pending');
  });

  it('answers 409 confirmations_closed for a waiting order that already left the round', async () => {
    const { order } = await seedInRound();
    expect((await press('decline', order.token)).status).toBe(200);
    const before = await storedState();

    const res = await press('confirm', order.token);

    expectConfirmationsClosed(res);
    expect(await storedState()).toStrictEqual(before);
    expect((await storedOrder(order.id)).status).toBe('waiting');
  });

  it('answers 409 confirmations_closed for a waiting order that was never in a round', async () => {
    const order = await seed();

    expectConfirmationsClosed(await press('confirm', order.token));
    expect((await storedOrder(order.id)).status).toBe('waiting');
  });

  it.each(['cancelled', 'collected'] as const satisfies readonly OrderStatus[])(
    'answers 409 invalid_transition for a %s order, changing nothing',
    async (status) => {
      const { order } = await seedInRound({ order: { status } });
      const before = await storedState();

      expectOrderClosed(await press('confirm', order.token));

      expect(await storedState()).toStrictEqual(before);
    },
  );

  it('answers 409 and leaves the order cancelled when a cancel lands just before the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { order } = await seedInRound();
    racing.racesBeforeConditionalWrite.set(order.id, [CANCELLED_MEANWHILE]);

    const res = await press('confirm', order.token);

    expectOrderClosed(res);
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.cancelledAt).toStrictEqual(CANCELLED_MEANWHILE.cancelledAt);
  });

  it('answers 200 when another confirm lands just before the write (a double tap racing itself)', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { order } = await seedInRound();
    racing.racesBeforeConditionalWrite.set(order.id, [CONFIRMED_MEANWHILE]);

    const res = await press('confirm', order.token);

    expect(orderOf(res).status).toBe('confirmed');
    // The confirm that landed first stands; this one wrote nothing.
    expect((await storedOrder(order.id)).updatedAt).toStrictEqual(CONFIRMED_MEANWHILE.updatedAt);
  });
});

describe('POST /api/o/:token/decline', () => {
  it('takes a pending order out of its round: waiting, no roundId, lastMiss askedOtherDate', async () => {
    const { order, round } = await seedInRound();
    const before = new Date();

    const res = await press('decline', order.token);

    const after = new Date();
    expect(res.headers['cache-control']).toBe('no-store');
    const page = orderOf(res);
    expect(page.status).toBe('waiting');
    expect(page).not.toHaveProperty('round');
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('waiting');
    expect(stored).not.toHaveProperty('roundId');
    expect(stored.lastMiss).toStrictEqual({
      date: round.date,
      reason: 'askedOtherDate',
      roundId: round.id,
    });
    expect(stored.messages).toStrictEqual([MANUAL_REQUEST]);
    expectBetween(stored.updatedAt, before, after);
    // The round itself is not touched: its orderIds still lists the order, for the view below.
    expect(await rounds.findById(round.id)).toStrictEqual(round);
  });

  it('shows the order under "ביקשו מועד אחר" in Yoel\'s round view', async () => {
    const { order, round } = await seedInRound();

    await press('decline', order.token);

    expect(groupsOf(await roundView(round.id))).toStrictEqual({
      confirmed: [],
      pending: [],
      otherDate: [order.id],
    });
  });

  it('leaves the order free to be planned into a new round', async () => {
    const { order } = await seedInRound();
    await press('decline', order.token);

    const res = await request(app)
      .post('/api/collector/rounds')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send({ date: '2026-11-19', region: 'ramat', orderIds: [order.id] });

    expect(res.status).toBe(201);
    const newRound = roundViewSchema.parse(res.body).round;
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('pending');
    expect(stored.roundId).toBe(newRound.id);
  });

  it('answers 200 to a double tap, and the second writes nothing', async () => {
    const { order } = await seedInRound();

    const first = await press('decline', order.token);
    const afterFirst = await storedOrder(order.id);
    const second = await press('decline', order.token);

    expect(orderOf(first).status).toBe('waiting');
    expect(orderOf(second).status).toBe('waiting');
    expect(await storedOrder(order.id)).toStrictEqual(afterFirst);
  });

  it('takes a confirmed order out of its round too', async () => {
    const { order, round } = await seedInRound({ order: { status: 'confirmed' } });

    const res = await press('decline', order.token);

    expect(orderOf(res).status).toBe('waiting');
    const stored = await storedOrder(order.id);
    expect(stored).not.toHaveProperty('roundId');
    expect(stored.lastMiss).toStrictEqual({
      date: round.date,
      reason: 'askedOtherDate',
      roundId: round.id,
    });
  });

  it('works after the route was built too', async () => {
    const { order } = await seedInRound({ round: { phase: 'routed' } });

    expect(orderOf(await press('decline', order.token)).status).toBe('waiting');
    expect((await storedOrder(order.id)).status).toBe('waiting');
  });

  it.each(['cancelled', 'collected'] as const satisfies readonly OrderStatus[])(
    'answers 409 invalid_transition for a %s order, changing nothing',
    async (status) => {
      const { order } = await seedInRound({ order: { status } });
      const before = await storedState();

      expectOrderClosed(await press('decline', order.token));

      expect(await storedState()).toStrictEqual(before);
    },
  );

  it('decides again from the new status when Yoel confirms by phone just before the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { order, round } = await seedInRound();
    racing.racesBeforeConditionalWrite.set(order.id, [CONFIRMED_MEANWHILE]);

    const res = await press('decline', order.token);

    // The customer's "not this time" still stands: confirmed may leave the round as well.
    expect(orderOf(res).status).toBe('waiting');
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('waiting');
    expect(stored.lastMiss?.roundId).toBe(round.id);
  });
});

describe('POST /api/o/:token/cancel', () => {
  it.each(['pending', 'confirmed'] as const satisfies readonly OrderStatus[])(
    'cancels a %s order in a round, with cancelledAt',
    async (status) => {
      const { order } = await seedInRound({ order: { status } });
      const before = new Date();

      const res = await press('cancel', order.token);

      const after = new Date();
      expect(res.headers['cache-control']).toBe('no-store');
      const page = orderOf(res);
      expect(page.status).toBe('cancelled');
      expect(page).not.toHaveProperty('round');
      const stored = await storedOrder(order.id);
      expect(stored.status).toBe('cancelled');
      expectBetween(stored.cancelledAt, before, after);
      expect(stored.updatedAt).toStrictEqual(stored.cancelledAt);
      expect(stored.messages).toStrictEqual([MANUAL_REQUEST]);
    },
  );

  it('cancels a waiting order, with cancelledAt', async () => {
    const order = await seed();
    const before = new Date();

    const res = await press('cancel', order.token);

    const after = new Date();
    expect(orderOf(res).status).toBe('cancelled');
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('cancelled');
    expectBetween(stored.cancelledAt, before, after);
    expect(stored.updatedAt).toStrictEqual(stored.cancelledAt);
  });

  it('answers 200 to a double tap, and cancelledAt keeps the first moment', async () => {
    const order = await seed();

    const first = await press('cancel', order.token);
    const afterFirst = await storedOrder(order.id);
    const second = await press('cancel', order.token);

    expect(orderOf(first).status).toBe('cancelled');
    expect(orderOf(second).status).toBe('cancelled');
    expect(await storedOrder(order.id)).toStrictEqual(afterFirst);
  });

  it('answers 409 invalid_transition for a collected order, changing nothing', async () => {
    const { order } = await seedInRound({ order: { status: 'collected' } });
    const before = await storedState();

    expectOrderClosed(await press('cancel', order.token));

    expect(await storedState()).toStrictEqual(before);
  });

  it('keeps the roundId of an order cancelled in a round, which the round view lists in no group', async () => {
    const { order, round } = await seedInRound();

    await press('cancel', order.token);

    expect((await storedOrder(order.id)).roundId).toBe(round.id);
    expect(groupsOf(await roundView(round.id))).toStrictEqual({
      confirmed: [],
      pending: [],
      otherDate: [],
    });
  });

  it('answers 409 when the order changes twice before its writes, without a third try', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { order } = await seedInRound();
    // Yoel confirms by phone before the first write, then the order leaves the round before the
    // second: both writes find another status.
    racing.racesBeforeConditionalWrite.set(order.id, [
      CONFIRMED_MEANWHILE,
      { status: 'waiting', roundId: undefined, updatedAt: new Date('2026-11-11T11:00:00.000Z') },
    ]);

    const res = await press('cancel', order.token);

    expectOrderClosed(res);
    expect((await storedOrder(order.id)).status).toBe('waiting');
  });
});

describe('PATCH /api/o/:token: a waiting order', () => {
  it('replaces the address with one on a listed street and derives its region', async () => {
    const order = await seed();
    expect(order).not.toHaveProperty('region');
    const before = new Date();

    const res = await patchOrder(order.token, { address: OLD_INPUT });

    const after = new Date();
    expect(res.headers['cache-control']).toBe('no-store');
    const page = orderOf(res);
    expect(page.address).toStrictEqual(OLD_ADDRESS);
    expect(page.status).toBe('waiting');
    expect(page).not.toHaveProperty('round');
    const stored = await storedOrder(order.id);
    expect(stored.address).toStrictEqual(OLD_ADDRESS);
    expect(stored.region).toBe('old');
    expect(stored.status).toBe('waiting');
    expect(stored).not.toHaveProperty('lastMiss');
    expectBetween(stored.updatedAt, before, after);
    // Everything the customer did not change is as it was.
    expect({ ...stored, address: order.address, updatedAt: order.updatedAt }).toStrictEqual({
      ...order,
      region: 'old',
    });
    // Yoel's "הזמנות" screen lists it under its new region.
    expect((await waitingGroups()).old).toStrictEqual([order.id]);
  });

  it('changes only the note', async () => {
    const order = await seed({ address: RAMAT_ADDRESS, region: 'ramat' });

    const res = await patchOrder(order.token, {
      address: { ...RAMAT_INPUT, note: '  הבקבוקים בשקית  ' },
    });

    expect(orderOf(res).address.note).toBe('הבקבוקים בשקית');
    const stored = await storedOrder(order.id);
    expect(stored.address).toStrictEqual({ ...RAMAT_ADDRESS, note: 'הבקבוקים בשקית' });
    expect(stored.region).toBe('ramat');
    expect(stored.status).toBe('waiting');
  });

  it.each([
    { label: 'a number', bottles: 45 },
    { label: 'text, as the form sends it', bottles: '45' },
  ])('changes only the number of bottles, sent as $label', async ({ bottles }) => {
    const order = await seed({ address: RAMAT_ADDRESS, region: 'ramat' });

    const res = await patchOrder(order.token, { bottlesEstimated: bottles });

    expect(orderOf(res).bottlesEstimated).toBe(45);
    const stored = await storedOrder(order.id);
    expect(stored.bottlesEstimated).toBe(45);
    expect(stored.address).toStrictEqual(RAMAT_ADDRESS);
    expect(stored.region).toBe('ramat');
  });
});

describe('PATCH /api/o/:token: the near street and the region', () => {
  it("keeps Yoel's near street and the region when only the house number changes", async () => {
    const order = await seed({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    await patchOrder(order.token, { address: { ...FREE_TEXT_INPUT, houseNumber: '19' } });

    const stored = await storedOrder(order.id);
    expect(stored.address).toStrictEqual({ ...FREE_TEXT_WITH_NEAR, houseNumber: '19' });
    expect(stored.region).toBe('ramat');
  });

  it("drops Yoel's near street on a move to another street, and derives the region from it", async () => {
    const order = await seed({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    const res = await patchOrder(order.token, { address: OLD_INPUT });

    expect(orderOf(res).address).toStrictEqual(OLD_ADDRESS);
    const stored = await storedOrder(order.id);
    expect(stored.address).toStrictEqual(OLD_ADDRESS);
    expect(stored.address).not.toHaveProperty('nearStreetCode');
    expect(stored.region).toBe('old');
  });

  it('removes the near street and the region on a move to a free-text street ("בלי אזור")', async () => {
    const order = await seed({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });
    const newAddress = {
      streetName: 'רחוב שאינו ברשימה',
      houseNumber: '4',
      bottlesSpot: 'privateHouse',
    } as const;

    await patchOrder(order.token, { address: newAddress });

    const stored = await storedOrder(order.id);
    expect(stored.address).toStrictEqual(newAddress);
    expect(stored).not.toHaveProperty('region');
    // For Yoel to assign: his "הזמנות" screen lists it under "בלי אזור".
    expect(await waitingGroups()).toStrictEqual({ ramat: [], old: [], none: [order.id] });
  });

  it('removes the region of a listed street on a move to a free-text street', async () => {
    const order = await seed({ address: RAMAT_ADDRESS, region: 'ramat' });

    await patchOrder(order.token, { address: FREE_TEXT_INPUT });

    const stored = await storedOrder(order.id);
    expect(stored.address).toStrictEqual({
      streetName: STREET_NAME,
      houseNumber: HOUSE_NUMBER,
      bottlesSpot: 'privateHouse',
    });
    expect(stored).not.toHaveProperty('region');
  });
});

describe('PATCH /api/o/:token: an order in a round', () => {
  const locationChanges: { label: string; address: AddressRequest }[] = [
    { label: 'a new street', address: OLD_INPUT },
    { label: 'a new house number alone', address: { ...RAMAT_INPUT, houseNumber: '9' } },
  ];
  const cases = (['pending', 'confirmed'] as const).flatMap((status) =>
    locationChanges.map((change) => ({ status, ...change })),
  );

  it.each(cases)(
    'takes a $status order out of its round on $label: waiting, no roundId, lastMiss addressChanged',
    async ({ status, address }) => {
      const { order, round } = await seedInRound({
        order: { status, address: RAMAT_ADDRESS, region: 'ramat' },
      });
      const before = new Date();

      const res = await patchOrder(order.token, { address });

      const after = new Date();
      const page = orderOf(res);
      expect(page.status).toBe('waiting');
      expect(page).not.toHaveProperty('round');
      const stored = await storedOrder(order.id);
      expect(stored.status).toBe('waiting');
      expect(stored).not.toHaveProperty('roundId');
      expect(stored.lastMiss).toStrictEqual({
        date: round.date,
        reason: 'addressChanged',
        roundId: round.id,
      });
      expect(stored.messages).toStrictEqual([MANUAL_REQUEST]);
      expectBetween(stored.updatedAt, before, after);
      // The round itself is not touched: its orderIds still lists the order.
      expect(await rounds.findById(round.id)).toStrictEqual(round);
    },
  );

  it.each(['pending', 'confirmed'] as const)(
    'lists a %s order that changed its address in no group of the round (it asked for no other date)',
    async (status) => {
      const { order, round } = await seedInRound({
        order: { status, address: RAMAT_ADDRESS, region: 'ramat' },
      });

      await patchOrder(order.token, { address: OLD_INPUT });

      expect(groupsOf(await roundView(round.id))).toStrictEqual({
        confirmed: [],
        pending: [],
        otherDate: [],
      });
    },
  );

  it.each(['pending', 'confirmed'] as const)(
    'leaves a %s order that changed its address free to be planned into a new round',
    async (status) => {
      const { order } = await seedInRound({
        order: { status, address: RAMAT_ADDRESS, region: 'ramat' },
      });
      await patchOrder(order.token, { address: { ...RAMAT_INPUT, houseNumber: '9' } });

      const res = await request(app)
        .post('/api/collector/rounds')
        .set(SAME_ORIGIN_HEADERS)
        .set('Cookie', cookie)
        .send({ date: '2026-11-19', region: 'ramat', orderIds: [order.id] });

      expect(res.status).toBe(201);
      const newRound = roundViewSchema.parse(res.body).round;
      const stored = await storedOrder(order.id);
      expect(stored.status).toBe('pending');
      expect(stored.roundId).toBe(newRound.id);
    },
  );

  const samePlaceChanges: { label: string; body: CustomerUpdateOrderRequest }[] = [
    { label: 'the note', body: { address: { ...RAMAT_INPUT, note: 'הערה חדשה' } } },
    {
      label: 'where the bottles wait, with the floor and apartment',
      body: {
        address: { ...RAMAT_INPUT, bottlesSpot: 'buildingEntrance', floorApt: 'כניסה ב' },
      },
    },
    { label: 'the bottles alone', body: { bottlesEstimated: 80 } },
  ];

  it.each(samePlaceChanges)(
    'keeps a pending order pending in its round on a change of $label',
    async ({ body }) => {
      const { order, round } = await seedInRound({
        order: { address: RAMAT_ADDRESS, region: 'ramat' },
      });

      const res = await patchOrder(order.token, body);

      const page = orderOf(res);
      expect(page.status).toBe('pending');
      expect(page.round).toStrictEqual({ date: DATE, pickupBy: PICKUP_BY });
      const stored = await storedOrder(order.id);
      expect(stored.status).toBe('pending');
      expect(stored.roundId).toBe(round.id);
      expect(stored).not.toHaveProperty('lastMiss');
      expect(groupsOf(await roundView(round.id)).pending).toStrictEqual([order.id]);
    },
  );

  it('keeps the message log intact, whether the order stays in the round or leaves it', async () => {
    const { order } = await seedInRound({ order: { address: RAMAT_ADDRESS, region: 'ramat' } });

    expect((await patchOrder(order.token, { bottlesEstimated: 70 })).status).toBe(200);
    expect((await storedOrder(order.id)).messages).toStrictEqual([MANUAL_REQUEST]);

    expect((await patchOrder(order.token, { address: OLD_INPUT })).status).toBe(200);
    const stored = await storedOrder(order.id);
    expect(stored.messages).toStrictEqual([MANUAL_REQUEST]);
    expect(stored.status).toBe('waiting');
  });
});

describe('PATCH /api/o/:token: refused changes', () => {
  const refusedAsAWhole: { label: string; body?: unknown }[] = [
    { label: 'a new phone', body: { contact: { name: NAME, phone: '0541234567' } } },
    {
      label: 'a new phone with an address',
      body: { contact: { name: NAME, phone: '0541234567' }, address: OLD_INPUT },
    },
    { label: 'a new name', body: { contact: { name: 'שם אחר', phone: '0547654321' } } },
    { label: 'a status', body: { status: 'confirmed' } },
    { label: 'a status with the bottles', body: { status: 'cancelled', bottlesEstimated: 50 } },
    { label: 'nothing to change', body: {} },
    { label: 'no body' },
  ];

  it.each(refusedAsAWhole)(
    'answers 400 invalid_order to $label, and nothing changes',
    async ({ body }) => {
      const { order } = await seedInRound({
        order: { contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' } },
      });
      const before = await storedState();

      const res = await patchOrder(order.token, body as object | undefined);

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({ error: 'invalid_order', fieldErrors: {} });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(await storedState()).toStrictEqual(before);
      expect((await storedOrder(order.id)).contact.phone).toBe(PHONE_E164);
    },
  );

  it("answers 400 with the form's message next to the field for fewer than 30 bottles", async () => {
    const order = await seed();
    const before = await storedState();

    const res = await patchOrder(order.token, { bottlesEstimated: '29' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'invalid_order',
      fieldErrors: { bottlesEstimated: ORDER_FORM_ERRORS.bottlesTooFew },
    });
    expect(await storedState()).toStrictEqual(before);
  });

  it("answers 400 with the form's message next to the field for an address with no house number", async () => {
    const order = await seed();

    const res = await patchOrder(order.token, { address: { ...OLD_INPUT, houseNumber: ' ' } });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'invalid_order',
      fieldErrors: { 'address.houseNumber': ORDER_FORM_ERRORS.houseNumberRequired },
    });
  });

  it('answers the same 400 to an invalid body whatever the token: it tells a guess nothing', async () => {
    const order = await seed();
    const body = { contact: { name: NAME, phone: '0541234567' } };

    const answers = await Promise.all(
      [order.token, UNKNOWN_TOKEN, ...MALFORMED_TOKENS].map((token) => patchOrder(token, body)),
    );

    for (const res of answers) {
      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({ error: 'invalid_order', fieldErrors: {} });
    }
  });

  it.each(['cancelled', 'collected'] as const satisfies readonly OrderStatus[])(
    'answers 409 invalid_transition for a %s order, changing nothing',
    async (status) => {
      const { order } = await seedInRound({ order: { status, address: RAMAT_ADDRESS } });
      const before = await storedState();

      expectOrderClosed(await patchOrder(order.token, { address: OLD_INPUT }));
      expectOrderClosed(await patchOrder(order.token, VALID_UPDATE));

      expect(await storedState()).toStrictEqual(before);
    },
  );

  it('answers 409 and leaves the cancelled order with its old address when a cancel lands just before the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { order } = await seedInRound({ order: { address: RAMAT_ADDRESS, region: 'ramat' } });
    racing.racesBeforeConditionalWrite.set(order.id, [CANCELLED_MEANWHILE]);

    const res = await patchOrder(order.token, { address: OLD_INPUT });

    expectOrderClosed(res);
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.address).toStrictEqual(RAMAT_ADDRESS);
    expect(stored.region).toBe('ramat');
    expect(stored.roundId).toBe(order.roundId);
    expect(stored).not.toHaveProperty('lastMiss');
  });

  it('decides again from the new status when Yoel confirms by phone just before the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { order, round } = await seedInRound({
      order: { address: RAMAT_ADDRESS, region: 'ramat' },
    });
    racing.racesBeforeConditionalWrite.set(order.id, [CONFIRMED_MEANWHILE]);

    const res = await patchOrder(order.token, { bottlesEstimated: 90 });

    const page = orderOf(res);
    expect(page.status).toBe('confirmed');
    expect(page.bottlesEstimated).toBe(90);
    const stored = await storedOrder(order.id);
    expect(stored.status).toBe('confirmed');
    expect(stored.roundId).toBe(round.id);
  });
});

describe('/api/o/:token: the Origin check', () => {
  it('refuses PATCH without a same-origin Origin with 403, changing nothing', async () => {
    const { order } = await seedInRound();
    const before = await storedState();

    const noOrigin = await request(app)
      .patch(`${BASE}/${order.token}`)
      .set('Host', TEST_HOST)
      .send({ address: OLD_INPUT });
    const otherSite = await request(app)
      .patch(`${BASE}/${order.token}`)
      .set('Host', TEST_HOST)
      .set('Origin', 'https://evil.example')
      .send({ address: OLD_INPUT });

    for (const res of [noOrigin, otherSite]) {
      expect(res.status).toBe(403);
      expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    }
    expect(await storedState()).toStrictEqual(before);
  });

  it.each(ACTIONS)(
    'refuses POST %s without a same-origin Origin with 403, changing nothing',
    async (action) => {
      const { order } = await seedInRound();
      const before = await storedState();

      const noOrigin = await request(app)
        .post(`${BASE}/${order.token}/${action}`)
        .set('Host', TEST_HOST);
      const otherSite = await request(app)
        .post(`${BASE}/${order.token}/${action}`)
        .set('Host', TEST_HOST)
        .set('Origin', 'https://evil.example');

      for (const res of [noOrigin, otherSite]) {
        expect(res.status).toBe(403);
        expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
      }
      expect(await storedState()).toStrictEqual(before);
    },
  );
});

describe('/api/o/:token: privacy', () => {
  it('logs nothing on any route: no phone, token, name or address', async () => {
    const { order } = await seedInRound({
      order: {
        contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
        address: {
          streetName: STREET_NAME,
          houseNumber: HOUSE_NUMBER,
          bottlesSpot: 'privateHouse',
        },
      },
    });

    await getPage(order.token);
    await press('confirm', order.token);
    await patchOrder(order.token, { address: { ...FREE_TEXT_INPUT, note: NOTE } });
    await patchOrder(order.token, { contact: { name: NAME, phone: '0541234567' } });
    await press('decline', order.token);
    await press('confirm', order.token);
    await press('cancel', order.token);
    await press('cancel', order.token);
    await patchOrder(order.token, VALID_UPDATE);
    await getPage(UNKNOWN_TOKEN);
    await press('confirm', 'abc');
    await patchOrder('abc', VALID_UPDATE);

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('logs an unexpected error without the token, and answers 500', async () => {
    const order = await seed({ contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' } });
    vi.spyOn(orders, 'findByToken').mockRejectedValue(new Error('database is down'));

    const res = await getPage(order.token);

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: 'internal' });
    const logged = consoleSpies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
    expect(logged).not.toBe('');
    for (const secret of [order.token, PHONE_E164, NAME]) expect(logged).not.toContain(secret);
  });
});
