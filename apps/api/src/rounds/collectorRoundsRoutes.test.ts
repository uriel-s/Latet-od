// Acceptance tests of /api/collector/rounds (spec §3.5 "תכנון סבב", §3.6 "אישורים" and building the route)
// through supertest against createApp(fakes): no listen(), no port, no database, no network. Each
// test keeps the in-memory repos and the FakeSender it passes in, seeds them with makeNewOrder /
// makeNewRound, and reads back what the routes stored and sent. Requests carry a valid session
// cookie (the collector is logged in), and every request that changes something comes from the
// site's own origin (SAME_ORIGIN_HEADERS), as the web app's does, except in the guard's and the
// Origin check's own tests.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  COLLECTOR_ORDER_MESSAGES,
  CUSTOMER_ORDER_MESSAGES,
  MAX_ROUND_ORDERS,
  ROUND_MESSAGES,
  ROUND_PLAN_ERRORS,
  findStreet,
  roundViewSchema,
  roundsResponseSchema,
  toCollectorOrder,
  type MessageLogEntry,
  type NewOrder,
  type NewRound,
  type Order,
  type PlanRoundRequest,
  type Round,
  type RoundGroupKey,
  type RoundStop,
  type RoundView,
  type Street,
} from '@bottlerun/shared';
import { createApp } from '../app.ts';
import { loggedInCookie } from '../auth/testSession.ts';
import {
  FAKE_PUBLIC_BASE_URL,
  createFakeAuth,
  createFakeDeps,
  createFakeMessaging,
} from '../fakeDeps.ts';
import { FakeSender } from '../messages/fakeSender.ts';
import type { MessageSender } from '../messages/messageSender.ts';
import { WaMeLinkSender } from '../messages/waMeLinkSender.ts';
import { InMemoryOrdersRepo } from '../orders/inMemoryOrdersRepo.ts';
import { makeNewOrder } from '../orders/makeOrder.ts';
import type { OrderPatch, OrderUpdateOptions } from '../orders/ordersRepo.ts';
import { SAME_ORIGIN_HEADERS, TEST_HOST } from '../testRequest.ts';
import { InMemoryRoundsRepo } from './inMemoryRoundsRepo.ts';
import { makeNewRound } from './makeRound.ts';
import type { RoundPatch, RoundUpdateOptions } from './roundsRepo.ts';

const BASE = '/api/collector/rounds';
/** Shaped like a Mongo ObjectId, but no order or round has it. */
const UNKNOWN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MALFORMED_ID = 'not-an-id';

// What Yoel types on the planning screen.
const DATE = '2026-11-12';
const PERSONAL_TEXT = 'נעבור אצלכם בבוקר. תודה רבה!';
const PICKUP_BY = '08:00';

// A customer's data. Distinctive values, so "the log does not contain it" cannot pass or fail by
// accident. The phone starts 054, never the 050 of makeNewOrder's phones.
const NAME = 'רבקה לוינסון';
const PHONE_E164 = '+972547654321';
const HOUSE_NUMBER = '17ב';

const MANUAL_REQUEST_URL = 'https://wa.me/972500000000?text=confirm';
/** A confirmation request already sent as a wa.me link (ADR-0003), for orders seeded in a round. */
const MANUAL_REQUEST: MessageLogEntry = {
  kind: 'confirmRequest',
  at: new Date('2026-11-11T17:00:00.000Z'),
  mode: 'manual',
  url: MANUAL_REQUEST_URL,
};

/**
 * An in-memory orders repo where the customer acts at the worst moment: just before a route's
 * conditional write (`ifStatus`) to an id in {@link cancelBeforeConditionalWrite}, the order is
 * cancelled; to an id in {@link confirmBeforeConditionalWrite}, it is confirmed (the customer's
 * "כן, אוציא את הבקבוקים"). Either way the write finds another status and answers null. Unconditional
 * writes (the message log) go through as usual.
 */
class RacingOrdersRepo extends InMemoryOrdersRepo {
  /** Ids of the orders cancelled just before a conditional write. */
  readonly cancelBeforeConditionalWrite = new Set<string>();
  /** Ids of the orders confirmed just before a conditional write. */
  readonly confirmBeforeConditionalWrite = new Set<string>();

  override async update(
    id: string,
    patch: OrderPatch,
    options?: OrderUpdateOptions,
  ): Promise<Order | null> {
    if (options?.ifStatus !== undefined) {
      const now = new Date();
      if (this.cancelBeforeConditionalWrite.has(id)) {
        await super.update(id, { status: 'cancelled', cancelledAt: now, updatedAt: now });
      } else if (this.confirmBeforeConditionalWrite.has(id)) {
        await super.update(id, { status: 'confirmed', updatedAt: now });
      }
    }
    return super.update(id, patch, options);
  }
}

/**
 * An in-memory rounds repo where Yoel closes the round at the worst moment: just before a
 * conditional write (`ifStatus` / `ifPhase`) to an id in {@link closeBeforeConditionalWrite}, the
 * round is closed ("סגור סבב" from another screen), so the write finds it closed and answers null.
 */
class ClosingRoundsRepo extends InMemoryRoundsRepo {
  /** Ids of the rounds closed just before a conditional write. */
  readonly closeBeforeConditionalWrite = new Set<string>();

  override async update(
    id: string,
    patch: RoundPatch,
    options?: RoundUpdateOptions,
  ): Promise<Round | null> {
    const conditional = options?.ifStatus !== undefined || options?.ifPhase !== undefined;
    if (conditional && this.closeBeforeConditionalWrite.has(id)) {
      await super.update(id, { status: 'closed', closedAt: new Date() });
    }
    return super.update(id, patch, options);
  }
}

let orders: InMemoryOrdersRepo;
let rounds: InMemoryRoundsRepo;
/** The FakeSender of the app, unless a test builds its app with another sender. */
let sender: FakeSender;
let app: Express;
let cookie: string;
let consoleSpies: MockInstance<typeof console.error>[];

/**
 * Builds the test's app on fresh repos (or on `options.orders` / `options.rounds`), with its own fake login on the
 * real clock and a session issued now (valid, and too new to renew). Seed AFTER calling it: it
 * replaces the module's `orders` and `rounds`.
 */
function buildApp(
  options: {
    orders?: InMemoryOrdersRepo;
    rounds?: InMemoryRoundsRepo;
    messageSender?: MessageSender;
  } = {},
) {
  orders = options.orders ?? new InMemoryOrdersRepo();
  rounds = options.rounds ?? new InMemoryRoundsRepo();
  sender = new FakeSender();
  const auth = createFakeAuth();
  app = createApp(
    createFakeDeps({
      orders,
      rounds,
      auth,
      messaging: createFakeMessaging({ sender: options.messageSender ?? sender }),
    }),
  );
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

/** Stores `count` waiting orders, one after the other (so in creation order). */
async function seedMany(count: number): Promise<Order[]> {
  const seeded: Order[] = [];
  for (let n = 0; n < count; n += 1) seeded.push(await seed());
  return seeded;
}

/** Stores a made round (see makeNewRound): open, confirming, on 2026-11-12, unless overridden. */
function seedRound(overrides: Partial<NewRound> = {}): Promise<Round> {
  return rounds.create(makeNewRound(overrides));
}

/** The stored order with this id; fails the test when there is none. */
async function storedOrder(id: string): Promise<Order> {
  const order = await orders.findById(id);
  if (order === null) throw new Error('no stored order has this id');
  return order;
}

/** The stored round with this id; fails the test when there is none. */
async function storedRound(id: string): Promise<Round> {
  const round = await rounds.findById(id);
  if (round === null) throw new Error('no stored round has this id');
  return round;
}

/** The only stored round; fails the test when there is not exactly one. */
async function onlyRound(): Promise<Round> {
  const all = await rounds.list();
  expect(all).toHaveLength(1);
  const [round] = all;
  if (round === undefined) throw new Error('no round is stored');
  return round;
}

/** Everything a refused request must leave as it was: orders, rounds, and messages sent. */
async function storedState(): Promise<{ orders: Order[]; rounds: Round[]; sent: number }> {
  return { orders: await orders.list(), rounds: await rounds.list(), sent: sender.sent.length };
}

/** A valid plan, as the planning screen sends it: the date, ramat, a personal text, 08:00. */
function planBody(orderIds: string[], overrides: Partial<PlanRoundRequest> = {}): PlanRoundRequest {
  return {
    date: DATE,
    region: 'ramat',
    orderIds,
    personalText: PERSONAL_TEXT,
    pickupBy: PICKUP_BY,
    ...overrides,
  };
}

/** Logged-in requests, as the collector app sends them. */
function plan(body: object | undefined): request.Test {
  const req = request(app).post(BASE).set(SAME_ORIGIN_HEADERS).set('Cookie', cookie);
  return body === undefined ? req : req.send(body);
}

function getRounds(): request.Test {
  return request(app).get(BASE).set('Cookie', cookie);
}

function getRound(id: string): request.Test {
  return request(app).get(`${BASE}/${id}`).set('Cookie', cookie);
}

/** "אישר בטלפון". */
function confirmByPhone(roundId: string, orderId: string): request.Test {
  return request(app)
    .post(`${BASE}/${roundId}/orders/${orderId}/confirm-by-phone`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
}

/** "סגור אישורים ובנה מסלול": no body. */
function buildRoute(roundId: string): request.Test {
  return request(app)
    .post(`${BASE}/${roundId}/route`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
}

/** Moves the stop of `orderId` in the round's route; `body` left out sends no body at all. */
function moveStopOf(roundId: string, orderId: string, body?: object): request.Test {
  const req = request(app)
    .post(`${BASE}/${roundId}/stops/${orderId}/move`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
  return body === undefined ? req : req.send(body);
}

/** The customer's "כן, אוציא את הבקבוקים" on their own page (no login). */
function customerConfirm(token: string): request.Test {
  return request(app).post(`/api/o/${token}/confirm`).set(SAME_ORIGIN_HEADERS);
}

/** Expects the 409 of a round whose confirmations are closed (routed or closed). */
function expectConfirmationsClosed(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'confirmations_closed',
    message: ROUND_MESSAGES.confirmationsClosed,
  });
}

/** The round's view in a 200/201 body, checked against the shared contract the web app parses. */
function viewOf(res: request.Response): RoundView {
  return roundViewSchema.parse(res.body);
}

/** The ids of the orders in the group `key` of a view. */
function groupIds(view: RoundView, key: RoundGroupKey): string[] {
  return view.groups.find((group) => group.key === key)?.orders.map((order) => order.id) ?? [];
}

/** The three groups of a view as ids, in screen order. */
function groupsOf(view: RoundView): Record<RoundGroupKey, string[]> {
  return {
    confirmed: groupIds(view, 'confirmed'),
    pending: groupIds(view, 'pending'),
    otherDate: groupIds(view, 'otherDate'),
  };
}

/** The order ids of a view's "שלח" list, in order. */
function sendListIds(view: RoundView): string[] {
  return view.sendList.map((row) => row.orderId);
}

/** Expects `date` to be inside [before, after]: a time the route took from the real clock. */
function expectBetween(date: Date | undefined, before: Date, after: Date): void {
  expect(date).toBeInstanceOf(Date);
  expect(date?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(date?.getTime()).toBeLessThanOrEqual(after.getTime());
}

/** Expects the 409 of a move on a round with no open route (still confirming, or closed). */
function expectRouteNotOpen(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({ error: 'route_not_open', message: ROUND_MESSAGES.routeNotOpen });
}

/** Expects the 409 of a plan with ids that cannot be planned, listing exactly `orderIds`. */
function expectOrdersNotWaiting(res: request.Response, orderIds: string[]): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'orders_not_waiting',
    message: ROUND_MESSAGES.ordersNotWaiting,
    orderIds,
  });
}

/** Expects the 409 of an order whose status does not allow "אישר בטלפון". */
function expectInvalidTransition(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'invalid_transition',
    message: COLLECTOR_ORDER_MESSAGES.orderClosed,
  });
}

// The route tests (building it, moving a stop) seed their rounds with these.
//
// Three ramat streets of the real list on the straight line from FAKE_ROUTE_START (31.7, 35.0)
// to DROP_OFF (נחל נחשון): אהרונסון right by the start, גני שמש halfway, נחל רביבים by the
// drop-off. So the driving order is that one, whatever order they are planned in.
const BY_START = 370;
const HALFWAY = 6502;
const BY_DROP_OFF = 440;

/** A street of the real list with a point; fails the test if the list no longer has one. */
function locatedStreet(code: number): Street {
  const street = findStreet(code);
  if (street?.lat === undefined) throw new Error('the street has no point in streets.json');
  return street;
}

/** An order's address on the listed street `code`. */
function addressOn(code: number): NewOrder['address'] {
  const street = locatedStreet(code);
  return {
    streetCode: street.code,
    streetName: street.name,
    houseNumber: '3',
    bottlesSpot: 'privateHouse',
  };
}

/**
 * Stores an open, confirming round (unless overridden) and one order in it per entry, in plan
 * order: `confirmed` or `pending` (with its request sent), on a listed street, or on a
 * free-text street (no point) when `street` is left out.
 */
async function seedRoundWith(
  entries: { status: 'confirmed' | 'pending'; street?: number }[],
  roundOverrides: Partial<NewRound> = {},
): Promise<{ round: Round; inRound: Order[] }> {
  const round = await seedRound(roundOverrides);
  const inRound: Order[] = [];
  for (const { status, street } of entries) {
    inRound.push(
      await seed({
        status,
        roundId: round.id,
        messages: [MANUAL_REQUEST],
        ...(street === undefined ? {} : { address: addressOn(street), region: 'ramat' as const }),
      }),
    );
  }
  const updated = await rounds.update(round.id, { orderIds: inRound.map((order) => order.id) });
  if (updated === null) throw new Error('the round just stored is gone');
  return { round: updated, inRound };
}

/** A view's stops as stored stops plus their state. */
function stopsOf(view: RoundView): (RoundStop & { state: string })[] {
  return view.stops.map((stop) => ({
    orderId: stop.order.id,
    hasLocation: stop.hasLocation,
    state: stop.state,
  }));
}

describe('POST /api/collector/rounds: "תכנון סבב" and "שלח בקשות אישור"', () => {
  it('stores an open round, moves its orders to pending and answers 201 with a "שלח" row per order', async () => {
    const [first, second, third] = await seedMany(3);
    if (first === undefined || second === undefined || third === undefined) throw new Error();
    // Not the creation order: the round keeps the order Yoel sent.
    const planned = [third, first, second];
    const before = new Date();

    const res = await plan(planBody(planned.map((order) => order.id)));

    const after = new Date();
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');

    // The round: open, confirming, no route yet, with what Yoel typed.
    const round = await onlyRound();
    expect(round).toStrictEqual({
      id: round.id,
      date: DATE,
      region: 'ramat',
      status: 'open',
      phase: 'confirming',
      personalText: PERSONAL_TEXT,
      pickupBy: PICKUP_BY,
      orderIds: planned.map((order) => order.id),
      stops: [],
      createdAt: round.createdAt,
    });
    expectBetween(round.createdAt, before, after);

    // Each order: pending in the round, and its confirmation request logged as a wa.me link
    // (the FakeSender's urls are numbered in sending order).
    for (const [position, order] of planned.entries()) {
      const now = await storedOrder(order.id);
      expect(now.status).toBe('pending');
      expect(now.roundId).toBe(round.id);
      expectBetween(now.updatedAt, before, after);
      expect(now.messages).toStrictEqual([
        {
          kind: 'confirmRequest',
          at: expect.any(Date) as Date,
          mode: 'manual',
          url: `https://fake-sender.test/${position + 1}`,
        },
      ]);
    }

    // One confirmation request per order, in plan order, with the round's date, pickup time and
    // personal text, and the link to the customer's own page.
    expect(sender.sent).toStrictEqual(
      planned.map((order) => ({
        kind: 'confirmRequest',
        orderId: order.id,
        to: order.contact.phone,
        vars: {
          name: order.contact.name,
          link: `${FAKE_PUBLIC_BASE_URL}/o/${order.token}`,
          date: DATE,
          pickupBy: PICKUP_BY,
        },
        personalText: PERSONAL_TEXT,
      })),
    );

    // The answer: the round's view, every order waiting for its confirmation.
    const view = viewOf(res);
    expect(view.round).toStrictEqual({
      id: round.id,
      date: DATE,
      region: 'ramat',
      status: 'open',
      phase: 'confirming',
      personalText: PERSONAL_TEXT,
      pickupBy: PICKUP_BY,
      createdAt: round.createdAt,
    });
    expect(groupsOf(view)).toStrictEqual({
      confirmed: [],
      pending: planned.map((order) => order.id),
      otherDate: [],
    });
    expect(view.sendList).toStrictEqual(
      planned.map((order, position) => ({
        orderId: order.id,
        messageIndex: 0,
        kind: 'confirmRequest',
        name: order.contact.name,
        url: `https://fake-sender.test/${position + 1}`,
      })),
    );
    // Yoel's screens never get the token (toCollectorOrder).
    for (const order of planned) expect(res.text).not.toContain(order.token);
  });

  it('stores a pickup window and says it in every confirmation request', async () => {
    const order = await seed();

    const res = await plan(planBody([order.id], { pickupFrom: '07:00' }));

    expect(res.status).toBe(201);
    const round = await onlyRound();
    expect(round.pickupFrom).toBe('07:00');
    expect(round.pickupBy).toBe(PICKUP_BY);
    expect(viewOf(res).round.pickupFrom).toBe('07:00');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.vars).toStrictEqual({
      name: order.contact.name,
      link: `${FAKE_PUBLIC_BASE_URL}/o/${order.token}`,
      date: DATE,
      pickupFrom: '07:00',
      pickupBy: PICKUP_BY,
    });
  });

  it('leaves pickupFrom out of the round and the messages when none is given', async () => {
    const order = await seed();

    await plan(planBody([order.id]));

    expect(await onlyRound()).not.toHaveProperty('pickupFrom');
    expect(sender.sent[0]?.vars).not.toHaveProperty('pickupFrom');
  });

  it('leaves out a personal text and a pickup time left empty: not stored, not in the messages', async () => {
    const order = await seed();

    const res = await plan(planBody([order.id], { personalText: '   ', pickupBy: '' }));

    expect(res.status).toBe(201);
    const round = await onlyRound();
    expect(round).not.toHaveProperty('personalText');
    expect(round).not.toHaveProperty('pickupBy');
    expect(sender.sent).toStrictEqual([
      {
        kind: 'confirmRequest',
        orderId: order.id,
        to: order.contact.phone,
        vars: {
          name: order.contact.name,
          link: `${FAKE_PUBLIC_BASE_URL}/o/${order.token}`,
          date: DATE,
        },
      },
    ]);
  });

  it('with the real WaMeLinkSender, gives each order a wa.me link to its phone that carries its page link', async () => {
    buildApp({ messageSender: new WaMeLinkSender() });
    const planned = await seedMany(2);

    const res = await plan(planBody(planned.map((order) => order.id)));

    expect(res.status).toBe(201);
    const view = viewOf(res);
    expect(sendListIds(view)).toStrictEqual(planned.map((order) => order.id));
    for (const [position, order] of planned.entries()) {
      const url = view.sendList[position]?.url ?? '';
      expect(url.startsWith('https://wa.me/972')).toBe(true);
      // The customer's own phone, E.164 without the `+`.
      expect(url.startsWith(`https://wa.me/${order.contact.phone.slice(1)}?text=`)).toBe(true);
      const text = decodeURIComponent(url.slice(url.indexOf('?text=') + '?text='.length));
      expect(text).toContain(`${FAKE_PUBLIC_BASE_URL}/o/${order.token}`);
      expect(text).toContain(PERSONAL_TEXT);
      expect(text).toContain(PICKUP_BY);
    }
  });

  it('accepts 25 orders, the most a round may have', async () => {
    const planned = await seedMany(MAX_ROUND_ORDERS);

    const res = await plan(planBody(planned.map((order) => order.id)));

    expect(res.status).toBe(201);
    const view = viewOf(res);
    expect(groupIds(view, 'pending')).toHaveLength(MAX_ROUND_ORDERS);
    expect(view.sendList).toHaveLength(MAX_ROUND_ORDERS);
    expect(sender.sent).toHaveLength(MAX_ROUND_ORDERS);
  });

  it('refuses 26 orders with 400 invalid_round and the plain message, writing nothing', async () => {
    const seeded = await seedMany(MAX_ROUND_ORDERS + 1);
    const before = await storedState();

    const res = await plan(planBody(seeded.map((order) => order.id)));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'invalid_round',
      fieldErrors: { orderIds: ROUND_PLAN_ERRORS.tooManyOrders },
    });
    expect(await storedState()).toStrictEqual(before);
  });

  it.each([
    {
      label: 'no date',
      body: { region: 'ramat', orderIds: ['x'] },
      fieldErrors: { date: ROUND_PLAN_ERRORS.dateRequired },
    },
    {
      label: 'a region that does not exist',
      body: { date: DATE, region: 'north', orderIds: ['x'] },
      fieldErrors: { region: ROUND_PLAN_ERRORS.regionRequired },
    },
    {
      label: 'no order marked',
      body: { date: DATE, region: 'ramat', orderIds: [] },
      fieldErrors: { orderIds: ROUND_PLAN_ERRORS.noOrders },
    },
    {
      label: 'the same order twice',
      body: { date: DATE, region: 'ramat', orderIds: ['x', 'x'] },
      fieldErrors: { orderIds: ROUND_PLAN_ERRORS.duplicateOrders },
    },
    {
      label: 'a pickup time that is not HH:MM',
      body: { date: DATE, region: 'ramat', orderIds: ['x'], pickupBy: '8am' },
      fieldErrors: { pickupBy: ROUND_PLAN_ERRORS.pickupByInvalid },
    },
    {
      label: 'a window start without an end',
      body: { date: DATE, region: 'ramat', orderIds: ['x'], pickupFrom: '07:00' },
      fieldErrors: { pickupBy: ROUND_PLAN_ERRORS.pickupUntilMissing },
    },
    {
      label: 'a window that starts at or after its end',
      body: {
        date: DATE,
        region: 'ramat',
        orderIds: ['x'],
        pickupFrom: '08:00',
        pickupBy: '08:00',
      },
      fieldErrors: { pickupFrom: ROUND_PLAN_ERRORS.pickupFromNotBeforeBy },
    },
    {
      label: 'an unknown key',
      body: { date: DATE, region: 'ramat', orderIds: ['x'], status: 'closed' },
      fieldErrors: {},
    },
    { label: 'no body', body: undefined, fieldErrors: {} },
  ])('refuses $label with 400 invalid_round, writing nothing', async ({ body, fieldErrors }) => {
    const order = await seed();
    const withOrder =
      body === undefined
        ? undefined
        : {
            ...body,
            // A real, waiting order where the case has one, so only the field under test is wrong.
            orderIds: body.orderIds.map(() => order.id),
          };
    const before = await storedState();

    const res = await plan(withOrder);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_round', fieldErrors });
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses an order already in an open round with 409 orders_not_waiting, writing nothing', async () => {
    // Acceptance: "הזמנה שכבר בסבב פתוח נדחית".
    const [inRound, waiting] = await seedMany(2);
    if (inRound === undefined || waiting === undefined) throw new Error();
    expect((await plan(planBody([inRound.id]))).status).toBe(201);
    const before = await storedState();

    const res = await plan(planBody([waiting.id, inRound.id], { date: '2026-11-19' }));

    expectOrdersNotWaiting(res, [inRound.id]);
    // No second round, the waiting order still waiting, and no message sent.
    expect(await storedState()).toStrictEqual(before);
    expect((await storedOrder(waiting.id)).status).toBe('waiting');
  });

  it('lists every id that cannot be planned, in the order sent, and writes nothing', async () => {
    const waiting = await seed();
    const cancelled = await seed({ status: 'cancelled', cancelledAt: new Date() });
    const confirmed = await seed({ status: 'confirmed', roundId: UNKNOWN_ID });
    const collected = await seed({ status: 'collected', collectedAt: new Date() });
    // A waiting order that still names a round: the app never writes this, and it is refused
    // rather than put in a second round.
    const strayWaiting = await seed({ roundId: UNKNOWN_ID });
    const before = await storedState();

    const res = await plan(
      planBody([
        waiting.id,
        cancelled.id,
        UNKNOWN_ID,
        confirmed.id,
        MALFORMED_ID,
        collected.id,
        strayWaiting.id,
      ]),
    );

    expectOrdersNotWaiting(res, [
      cancelled.id,
      UNKNOWN_ID,
      confirmed.id,
      MALFORMED_ID,
      collected.id,
      strayWaiting.id,
    ]);
    expect(await storedState()).toStrictEqual(before);
  });

  it('leaves out an order cancelled between the read and the write: no message, not in the round', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const [first, cancelledMeanwhile, last] = await seedMany(3);
    if (first === undefined || cancelledMeanwhile === undefined || last === undefined) {
      throw new Error();
    }
    racing.cancelBeforeConditionalWrite.add(cancelledMeanwhile.id);

    const res = await plan(planBody([first.id, cancelledMeanwhile.id, last.id]));

    expect(res.status).toBe(201);
    const round = await onlyRound();
    expect(round.orderIds).toStrictEqual([first.id, last.id]);
    expect(round.status).toBe('open');
    expect(sender.sent.map((message) => message.orderId)).toStrictEqual([first.id, last.id]);

    // The customer's cancel stands, untouched by the plan.
    const cancelled = await storedOrder(cancelledMeanwhile.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled).not.toHaveProperty('roundId');
    expect(cancelled.messages).toStrictEqual([]);

    const view = viewOf(res);
    expect(groupsOf(view)).toStrictEqual({
      confirmed: [],
      pending: [first.id, last.id],
      otherDate: [],
    });
    expect(sendListIds(view)).toStrictEqual([first.id, last.id]);
    expect(res.text).not.toContain(cancelledMeanwhile.id);
  });

  it('closes the round and answers 409 when every order was cancelled between the read and the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const seeded = await seedMany(2);
    for (const order of seeded) racing.cancelBeforeConditionalWrite.add(order.id);
    const before = new Date();

    const res = await plan(planBody(seeded.map((order) => order.id)));

    const after = new Date();
    expectOrdersNotWaiting(
      res,
      seeded.map((order) => order.id),
    );
    // The empty round is closed, so it never shows in the "סבבים" tab.
    const round = await onlyRound();
    expect(round.status).toBe('closed');
    expect(round.orderIds).toStrictEqual([]);
    expectBetween(round.closedAt, before, after);
    expect(await rounds.list({ statuses: ['open'] })).toStrictEqual([]);
    expect(sender.sent).toStrictEqual([]);
    for (const order of seeded) expect((await storedOrder(order.id)).status).toBe('cancelled');
  });

  it('still plans the round when the sender fails: the orders are pending, with no "שלח" rows', async () => {
    buildApp({ messageSender: new FakeSender(() => ({ mode: 'failed', reason: 'x' })) });
    const planned = await seedMany(2);

    const res = await plan(planBody(planned.map((order) => order.id)));

    expect(res.status).toBe(201);
    const round = await onlyRound();
    for (const order of planned) {
      const now = await storedOrder(order.id);
      expect(now.status).toBe('pending');
      expect(now.roundId).toBe(round.id);
      // The failure is logged on the order, so the screen can tell.
      expect(now.messages).toStrictEqual([
        { kind: 'confirmRequest', at: expect.any(Date) as Date, mode: 'failed', reason: 'x' },
      ]);
    }
    const view = viewOf(res);
    expect(groupIds(view, 'pending')).toStrictEqual(planned.map((order) => order.id));
    expect(view.sendList).toStrictEqual([]);
  });
});

describe('GET /api/collector/rounds: the "סבבים" tab', () => {
  it('lists only the open rounds, by date, each with its orders split into the right groups', async () => {
    // Acceptance: "תצוגת הסבב מחלקת נכון".
    const later = await seedRound({ date: '2026-11-20', region: 'old' });
    const sooner = await seedRound({ date: '2026-11-12' });
    const closed = await seedRound({ date: '2026-11-05', status: 'closed', closedAt: new Date() });

    const confirmed = await seed({ status: 'confirmed', roundId: sooner.id });
    const pending = await seed({
      status: 'pending',
      roundId: sooner.id,
      messages: [MANUAL_REQUEST],
    });
    // Left the round: back to waiting, no roundId, the miss pointing at the round.
    const otherDate = await seed({
      lastMiss: { date: sooner.date, reason: 'askedOtherDate', roundId: sooner.id },
    });
    // Cancelled while in the round: in no group.
    const cancelledInRound = await seed({
      status: 'cancelled',
      cancelledAt: new Date(),
      roundId: sooner.id,
    });
    // Waiting for a round, never planned: not this round's.
    const neverPlanned = await seed();
    await rounds.update(sooner.id, {
      orderIds: [pending.id, confirmed.id, otherDate.id, cancelledInRound.id],
    });

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = roundsResponseSchema.parse(res.body);
    expect(body.rounds.map((view) => view.round.id)).toStrictEqual([sooner.id, later.id]);

    const [soonerView, laterView] = body.rounds;
    if (soonerView === undefined || laterView === undefined) throw new Error();
    expect(groupsOf(soonerView)).toStrictEqual({
      confirmed: [confirmed.id],
      pending: [pending.id],
      otherDate: [otherDate.id],
    });
    expect(soonerView.sendList).toStrictEqual([
      {
        orderId: pending.id,
        messageIndex: 0,
        kind: 'confirmRequest',
        name: pending.contact.name,
        url: MANUAL_REQUEST_URL,
      },
    ]);
    expect(groupsOf(laterView)).toStrictEqual({ confirmed: [], pending: [], otherDate: [] });
    expect(laterView.sendList).toStrictEqual([]);

    expect(res.text).not.toContain(closed.id);
    expect(res.text).not.toContain(cancelledInRound.id);
    expect(res.text).not.toContain(neverPlanned.id);
  });

  it('answers previousPickupBy from the round created last, even a closed one', async () => {
    await seedRound({ pickupBy: '08:00', createdAt: new Date('2026-11-01T10:00:00.000Z') });
    await seedRound({
      status: 'closed',
      closedAt: new Date('2026-11-06T10:00:00.000Z'),
      pickupBy: '07:30',
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
    });

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(roundsResponseSchema.parse(res.body).previousPickupBy).toBe('07:30');
  });

  it('answers previousPickupFrom from the round created last, and leaves it out for an old round', async () => {
    await seedRound({
      pickupFrom: '07:00',
      pickupBy: '08:00',
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
    });
    expect(roundsResponseSchema.parse((await getRounds()).body).previousPickupFrom).toBe('07:00');

    await seedRound({ pickupBy: '08:00', createdAt: new Date('2026-11-05T10:00:00.000Z') });
    const res = await getRounds();
    expect(res.body).not.toHaveProperty('previousPickupFrom');
    expect(res.body).toHaveProperty('previousPickupBy', '08:00');
  });

  it('leaves previousPickupBy out when the round created last had none', async () => {
    await seedRound({ pickupBy: '08:00', createdAt: new Date('2026-11-01T10:00:00.000Z') });
    await seedRound({ createdAt: new Date('2026-11-05T10:00:00.000Z') });

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('previousPickupBy');
  });

  it('answers no rounds and no previousPickupBy when nothing was ever planned', async () => {
    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ rounds: [] });
  });

  it('shows a round planned through the api with its pickup time', async () => {
    const order = await seed();
    const planned = await plan(planBody([order.id]));

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(roundsResponseSchema.parse(res.body).previousPickupBy).toBe(PICKUP_BY);
    // The same view planning answered.
    expect(res.body).toStrictEqual({ rounds: [planned.body], previousPickupBy: PICKUP_BY });
  });
});

describe('GET /api/collector/rounds/:id', () => {
  it('answers the round view, the same as planning answered', async () => {
    const planned = await seedMany(2);
    const planRes = await plan(planBody(planned.map((order) => order.id)));
    const round = await onlyRound();

    const res = await getRound(round.id);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toStrictEqual(planRes.body);
  });

  it('answers a closed round too', async () => {
    const closedAt = new Date('2026-11-12T15:00:00.000Z');
    const round = await seedRound({ status: 'closed', phase: 'routed', closedAt });

    const res = await getRound(round.id);

    expect(res.status).toBe(200);
    expect(viewOf(res).round).toMatchObject({ id: round.id, status: 'closed', closedAt });
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers $label with 404 round_not_found', async ({ id }) => {
    await seedRound();

    const res = await getRound(id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'round_not_found' });
  });
});

describe('POST /api/collector/rounds/:id/orders/:orderId/confirm-by-phone: "אישר בטלפון"', () => {
  /** Plans a round of `count` waiting orders through the api; returns the round and its orders. */
  async function plannedRound(count: number): Promise<{ round: Round; planned: Order[] }> {
    const seeded = await seedMany(count);
    expect((await plan(planBody(seeded.map((order) => order.id)))).status).toBe(201);
    return { round: await onlyRound(), planned: seeded };
  }

  it('moves a pending order to confirmed and answers the view with it in "אישרו"', async () => {
    // Acceptance: "אישר בטלפון מעביר ל-confirmed".
    const { round, planned } = await plannedRound(2);
    const [first, second] = planned;
    if (first === undefined || second === undefined) throw new Error();
    const before = new Date();

    const res = await confirmByPhone(round.id, first.id);

    const after = new Date();
    expect(res.status).toBe(200);
    const stored = await storedOrder(first.id);
    expect(stored.status).toBe('confirmed');
    expect(stored.roundId).toBe(round.id);
    expectBetween(stored.updatedAt, before, after);

    const view = viewOf(res);
    expect(groupsOf(view)).toStrictEqual({
      confirmed: [first.id],
      pending: [second.id],
      otherDate: [],
    });
    // A confirmed customer needs no request: the "שלח" list shrinks.
    expect(sendListIds(view)).toStrictEqual([second.id]);
  });

  it('answers a second tap with 200 and writes nothing again', async () => {
    const { round, planned } = await plannedRound(1);
    const [order] = planned;
    if (order === undefined) throw new Error();
    const first = await confirmByPhone(round.id, order.id);
    const afterFirst = await storedOrder(order.id);

    const second = await confirmByPhone(round.id, order.id);

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual(first.body);
    // updatedAt keeps the first tap's moment.
    expect(await storedOrder(order.id)).toStrictEqual(afterFirst);
  });

  it('answers 404 order_not_found for an order of another round, changing nothing', async () => {
    const { round, planned } = await plannedRound(1);
    const [order] = planned;
    if (order === undefined) throw new Error();
    const other = await seedRound({ date: '2026-11-19' });
    const before = await storedOrder(order.id);

    const res = await confirmByPhone(other.id, order.id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
    expect(await storedOrder(order.id)).toStrictEqual(before);
    expect((await storedRound(round.id)).orderIds).toStrictEqual([order.id]);
  });

  it('answers 404 order_not_found for an order in no round, changing nothing', async () => {
    const { round } = await plannedRound(1);
    const waiting = await seed();

    const res = await confirmByPhone(round.id, waiting.id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
    expect(await storedOrder(waiting.id)).toStrictEqual(waiting);
  });

  it.each([
    { label: 'an unknown', id: UNKNOWN_ID },
    { label: 'a malformed', id: MALFORMED_ID },
  ])('answers $label order id with 404 order_not_found', async ({ id }) => {
    const { round } = await plannedRound(1);

    const res = await confirmByPhone(round.id, id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
  });

  it.each([
    { label: 'an unknown', id: UNKNOWN_ID },
    { label: 'a malformed', id: MALFORMED_ID },
  ])('answers $label round id with 404 round_not_found, changing nothing', async ({ id }) => {
    const { planned } = await plannedRound(1);
    const [order] = planned;
    if (order === undefined) throw new Error();
    const before = await storedOrder(order.id);

    const res = await confirmByPhone(id, order.id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'round_not_found' });
    expect(await storedOrder(order.id)).toStrictEqual(before);
  });

  it.each([
    { label: 'cancelled', overrides: { status: 'cancelled', cancelledAt: new Date() } },
    { label: 'collected', overrides: { status: 'collected', collectedAt: new Date() } },
  ] as const)(
    'refuses a $label order with 409 invalid_transition, changing nothing',
    async ({ overrides }) => {
      const round = await seedRound();
      const order = await seed({ ...overrides, roundId: round.id });
      await rounds.update(round.id, { orderIds: [order.id] });

      const res = await confirmByPhone(round.id, order.id);

      expectInvalidTransition(res);
      expect(await storedOrder(order.id)).toStrictEqual(order);
    },
  );

  it.each([
    { label: 'routed (confirmations closed)', overrides: { phase: 'routed' } },
    {
      label: 'closed',
      overrides: { status: 'closed', phase: 'routed', closedAt: new Date('2026-11-12T15:00:00Z') },
    },
  ] as const)(
    'refuses when the round is $label with 409 confirmations_closed, changing nothing',
    async ({ overrides }) => {
      const round = await seedRound(overrides);
      const order = await seed({
        status: 'pending',
        roundId: round.id,
        messages: [MANUAL_REQUEST],
      });
      await rounds.update(round.id, { orderIds: [order.id] });

      const res = await confirmByPhone(round.id, order.id);

      expect(res.status).toBe(409);
      expect(res.body).toStrictEqual({
        error: 'confirmations_closed',
        message: ROUND_MESSAGES.confirmationsClosed,
      });
      expect(await storedOrder(order.id)).toStrictEqual(order);
    },
  );

  it('answers 409 invalid_transition when the customer cancelled between the read and the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const round = await seedRound();
    const order = await seed({ status: 'pending', roundId: round.id, messages: [MANUAL_REQUEST] });
    await rounds.update(round.id, { orderIds: [order.id] });
    racing.cancelBeforeConditionalWrite.add(order.id);

    const res = await confirmByPhone(round.id, order.id);

    expectInvalidTransition(res);
    expect((await storedOrder(order.id)).status).toBe('cancelled');
  });
});

describe('POST /api/collector/rounds/:id/route: "סגור אישורים ובנה מסלול"', () => {
  it('sends the unconfirmed back to waiting and stores the confirmed as stops in driving order', async () => {
    // Acceptance: "מי שלא אישר יוצא מהסבב וחוזר לחכות"; the route is home → stops → drop-off.
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_DROP_OFF },
      { status: 'pending', street: HALFWAY },
      { status: 'confirmed', street: BY_START },
      { status: 'confirmed', street: HALFWAY },
      { status: 'pending' },
    ]);
    const [byDropOff, pendingA, byStart, halfway, pendingB] = inRound;
    if (!byDropOff || !pendingA || !byStart || !halfway || !pendingB) throw new Error();
    // Someone who asked for another date earlier: out of the round already, and left as it is.
    const askedOther = await seed({
      lastMiss: { date: round.date, reason: 'askedOtherDate', roundId: round.id },
    });
    await rounds.update(round.id, { orderIds: [...round.orderIds, askedOther.id] });
    const before = new Date();

    // Any body is ignored.
    const res = await buildRoute(round.id).send({ stops: [] });

    const after = new Date();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const expectedStops: RoundStop[] = [
      { orderId: byStart.id, hasLocation: true },
      { orderId: halfway.id, hasLocation: true },
      { orderId: byDropOff.id, hasLocation: true },
    ];
    const stored = await storedRound(round.id);
    expect(stored).toMatchObject({ status: 'open', phase: 'routed', stops: expectedStops });
    expect(stored.orderIds).toStrictEqual([...round.orderIds, askedOther.id]);

    const view = viewOf(res);
    expect(view.round).toMatchObject({ id: round.id, status: 'open', phase: 'routed' });
    expect(stopsOf(view)).toStrictEqual(
      expectedStops.map((stop) => ({ ...stop, state: 'toCollect' })),
    );
    // Each stop carries its order as Yoel's screens get it.
    expect(view.stops[0]?.order).toStrictEqual(toCollectorOrder(byStart));
    // The unconfirmed are in no group now; the confirmed stay in "אישרו", in plan order.
    expect(groupsOf(view)).toStrictEqual({
      confirmed: [byDropOff.id, byStart.id, halfway.id],
      pending: [],
      otherDate: [askedOther.id],
    });
    expect(view.sendList).toStrictEqual([]);

    for (const pending of [pendingA, pendingB]) {
      const left = await storedOrder(pending.id);
      expect(left.status).toBe('waiting');
      expect(left).not.toHaveProperty('roundId');
      expect(left.lastMiss).toStrictEqual({
        date: round.date,
        reason: 'notConfirmed',
        roundId: round.id,
      });
      expectBetween(left.updatedAt, before, after);
    }
    for (const untouched of [byDropOff, byStart, halfway, askedOther]) {
      expect(await storedOrder(untouched.id)).toStrictEqual(untouched);
    }
    // Building the route sends no message.
    expect(sender.sent).toHaveLength(0);
  });

  it('puts a confirmed order with no location last, with hasLocation false', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed' },
      { status: 'confirmed', street: BY_DROP_OFF },
      { status: 'confirmed', street: BY_START },
    ]);
    const [freeText, byDropOff, byStart] = inRound;
    if (!freeText || !byDropOff || !byStart) throw new Error();

    const res = await buildRoute(round.id);

    expect(res.status).toBe(200);
    const expectedStops: RoundStop[] = [
      { orderId: byStart.id, hasLocation: true },
      { orderId: byDropOff.id, hasLocation: true },
      { orderId: freeText.id, hasLocation: false },
    ];
    expect((await storedRound(round.id)).stops).toStrictEqual(expectedStops);
    expect(stopsOf(viewOf(res))).toStrictEqual(
      expectedStops.map((stop) => ({ ...stop, state: 'toCollect' })),
    );
  });

  it('refuses a second build with 409 confirmations_closed and recomputes nothing', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_START },
      { status: 'confirmed', street: BY_DROP_OFF },
    ]);
    const [first, second] = inRound;
    if (!first || !second) throw new Error();
    expect((await buildRoute(round.id)).status).toBe(200);
    // Yoel moved a stop by hand: a second build must not undo it.
    const moved: RoundStop[] = [
      { orderId: second.id, hasLocation: true },
      { orderId: first.id, hasLocation: true },
    ];
    await rounds.update(round.id, { stops: moved });
    const before = await storedState();

    const res = await buildRoute(round.id);

    expectConfirmationsClosed(res);
    expect(await storedState()).toStrictEqual(before);
    expect((await storedRound(round.id)).stops).toStrictEqual(moved);
  });

  it('refuses a closed round with 409 confirmations_closed, changing nothing', async () => {
    const { round } = await seedRoundWith([{ status: 'pending', street: BY_START }], {
      status: 'closed',
      closedAt: new Date('2026-11-12T15:00:00.000Z'),
    });
    const before = await storedState();

    const res = await buildRoute(round.id);

    expectConfirmationsClosed(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers $label with 404 round_not_found, changing nothing', async ({ id }) => {
    await seedRoundWith([{ status: 'pending', street: BY_START }]);
    const before = await storedState();

    const res = await buildRoute(id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'round_not_found' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('closes confirmations for the customer: a confirm after the build gets 409 "האישור נסגר"', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_START },
      { status: 'pending', street: HALFWAY },
    ]);
    const [, latecomer] = inRound;
    if (!latecomer) throw new Error();
    expect((await buildRoute(round.id)).status).toBe(200);
    const afterBuild = await storedOrder(latecomer.id);

    const res = await customerConfirm(latecomer.token);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({
      error: 'confirmations_closed',
      message: CUSTOMER_ORDER_MESSAGES.confirmationsClosed,
    });
    expect(await storedOrder(latecomer.id)).toStrictEqual(afterBuild);
  });

  it('refuses "אישר בטלפון" after the build with 409 confirmations_closed', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_START },
      { status: 'pending', street: HALFWAY },
    ]);
    const [stop] = inRound;
    if (!stop) throw new Error();
    expect((await buildRoute(round.id)).status).toBe(200);
    const before = await storedState();

    // The stop is still in the round, so it is the closed confirmations that answer, not a 404.
    const res = await confirmByPhone(round.id, stop.id);

    expectConfirmationsClosed(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('keeps as a stop a pending order the customer confirmed between the read and the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_DROP_OFF },
      { status: 'pending', street: BY_START },
      { status: 'pending', street: HALFWAY },
    ]);
    const [byDropOff, lastMinute, unconfirmed] = inRound;
    if (!byDropOff || !lastMinute || !unconfirmed) throw new Error();
    racing.confirmBeforeConditionalWrite.add(lastMinute.id);

    const res = await buildRoute(round.id);

    expect(res.status).toBe(200);
    const expectedStops: RoundStop[] = [
      { orderId: lastMinute.id, hasLocation: true },
      { orderId: byDropOff.id, hasLocation: true },
    ];
    expect((await storedRound(round.id)).stops).toStrictEqual(expectedStops);
    expect(stopsOf(viewOf(res)).map((stop) => stop.orderId)).toStrictEqual([
      lastMinute.id,
      byDropOff.id,
    ]);
    expect(await storedOrder(lastMinute.id)).toMatchObject({
      status: 'confirmed',
      roundId: round.id,
    });
    expect((await storedOrder(unconfirmed.id)).status).toBe('waiting');
  });

  it('leaves out a pending order the customer cancelled between the read and the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_START },
      { status: 'pending', street: HALFWAY },
    ]);
    const [stop, cancelled] = inRound;
    if (!stop || !cancelled) throw new Error();
    racing.cancelBeforeConditionalWrite.add(cancelled.id);

    const res = await buildRoute(round.id);

    expect(res.status).toBe(200);
    expect((await storedRound(round.id)).stops).toStrictEqual([
      { orderId: stop.id, hasLocation: true },
    ]);
    expect((await storedOrder(cancelled.id)).status).toBe('cancelled');
  });

  it('routes a round where nobody confirmed, with no stops', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'pending', street: BY_START },
      { status: 'pending' },
    ]);

    const res = await buildRoute(round.id);

    expect(res.status).toBe(200);
    expect(await storedRound(round.id)).toMatchObject({
      status: 'open',
      phase: 'routed',
      stops: [],
    });
    const view = viewOf(res);
    expect(view.stops).toStrictEqual([]);
    expect(groupsOf(view)).toStrictEqual({ confirmed: [], pending: [], otherDate: [] });
    for (const order of inRound) expect((await storedOrder(order.id)).status).toBe('waiting');
  });

  it('then answers GET /:id with the stops in their stored order, with details, location and state', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed' },
      { status: 'confirmed', street: BY_START },
      { status: 'confirmed', street: BY_DROP_OFF },
    ]);
    const [freeText, byStart, byDropOff] = inRound;
    if (!freeText || !byStart || !byDropOff) throw new Error();
    const built = await buildRoute(round.id);
    expect(built.status).toBe(200);

    const res = await getRound(round.id);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(built.body);
    const view = viewOf(res);
    expect(stopsOf(view)).toStrictEqual([
      { orderId: byStart.id, hasLocation: true, state: 'toCollect' },
      { orderId: byDropOff.id, hasLocation: true, state: 'toCollect' },
      { orderId: freeText.id, hasLocation: false, state: 'toCollect' },
    ]);
    expect(view.stops.map((stop) => stop.order)).toStrictEqual(
      [byStart, byDropOff, freeText].map(toCollectorOrder),
    );

    // The STORED order is what is answered: a stop Yoel moved by hand stays where he put it.
    const reversed = [...(await storedRound(round.id)).stops].reverse();
    await rounds.update(round.id, { stops: reversed });
    const again = viewOf(await getRound(round.id));
    expect(again.stops.map((stop) => stop.order.id)).toStrictEqual(
      reversed.map((stop) => stop.orderId),
    );
  });
});

describe('POST /api/collector/rounds/:id/stops/:orderId/move: moving a stop by hand', () => {
  /**
   * A routed round, built through the api: four confirmed stops in driving order (by the start,
   * halfway, by the drop-off, then a free-text street with no location), and one pending order
   * that the build sent back as notConfirmed.
   */
  async function seedRoutedRound(): Promise<{
    round: Round;
    stops: [Order, Order, Order, Order];
    sentBack: Order;
  }> {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed' },
      { status: 'confirmed', street: BY_DROP_OFF },
      { status: 'pending', street: HALFWAY },
      { status: 'confirmed', street: HALFWAY },
      { status: 'confirmed', street: BY_START },
    ]);
    const [freeText, byDropOff, sentBack, halfway, byStart] = inRound;
    if (!freeText || !byDropOff || !sentBack || !halfway || !byStart) throw new Error();
    expect((await buildRoute(round.id)).status).toBe(200);
    expect(await storedStopIds(round.id)).toStrictEqual([
      byStart.id,
      halfway.id,
      byDropOff.id,
      freeText.id,
    ]);
    return {
      round: await storedRound(round.id),
      stops: [byStart, halfway, byDropOff, freeText],
      sentBack,
    };
  }

  /** The stored stops of the round, as ids. */
  async function storedStopIds(roundId: string): Promise<string[]> {
    return (await storedRound(roundId)).stops.map((stop) => stop.orderId);
  }

  it('moves a stop up: swaps it with the one before it, stores it and answers the view', async () => {
    const { round, stops } = await seedRoutedRound();
    const [byStart, halfway, byDropOff, freeText] = stops;
    const ordersBefore = await orders.list();

    const res = await moveStopOf(round.id, halfway.id, { direction: 'up' });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const expectedStops: RoundStop[] = [
      { orderId: halfway.id, hasLocation: true },
      { orderId: byStart.id, hasLocation: true },
      { orderId: byDropOff.id, hasLocation: true },
      { orderId: freeText.id, hasLocation: false },
    ];
    // Only the stops changed: still open and routed, and nothing was recomputed.
    expect(await storedRound(round.id)).toStrictEqual({ ...round, stops: expectedStops });
    const view = viewOf(res);
    expect(view.round).toMatchObject({ id: round.id, status: 'open', phase: 'routed' });
    expect(stopsOf(view)).toStrictEqual(
      expectedStops.map((stop) => ({ ...stop, state: 'toCollect' })),
    );
    // GET /:id answers the same: the move is stored, not only answered.
    expect((await getRound(round.id)).body).toStrictEqual(res.body);
    // A move touches no order and sends no message.
    expect(await orders.list()).toStrictEqual(ordersBefore);
    expect(sender.sent).toHaveLength(0);
  });

  it('moves a stop down: swaps it with the one after it, each keeping its hasLocation', async () => {
    const { round, stops } = await seedRoutedRound();
    const [byStart, halfway, byDropOff, freeText] = stops;

    const res = await moveStopOf(round.id, byDropOff.id, { direction: 'down' });

    expect(res.status).toBe(200);
    const expectedStops: RoundStop[] = [
      { orderId: byStart.id, hasLocation: true },
      { orderId: halfway.id, hasLocation: true },
      { orderId: freeText.id, hasLocation: false },
      { orderId: byDropOff.id, hasLocation: true },
    ];
    expect((await storedRound(round.id)).stops).toStrictEqual(expectedStops);
    expect(
      stopsOf(viewOf(res)).map(({ orderId, hasLocation }) => ({ orderId, hasLocation })),
    ).toStrictEqual(expectedStops);
    expect((await getRound(round.id)).body).toStrictEqual(res.body);
  });

  it('keeps every move: two moves in a row build on each other', async () => {
    const { round, stops } = await seedRoutedRound();
    const [byStart, halfway, byDropOff, freeText] = stops;

    expect((await moveStopOf(round.id, freeText.id, { direction: 'up' })).status).toBe(200);
    expect((await moveStopOf(round.id, freeText.id, { direction: 'up' })).status).toBe(200);

    expect(await storedStopIds(round.id)).toStrictEqual([
      byStart.id,
      freeText.id,
      halfway.id,
      byDropOff.id,
    ]);
  });

  it('moves a stop whatever its state: a collected one too', async () => {
    const { round, stops } = await seedRoutedRound();
    const [byStart, halfway] = stops;
    await orders.update(halfway.id, { status: 'collected', updatedAt: new Date() });

    const res = await moveStopOf(round.id, halfway.id, { direction: 'up' });

    expect(res.status).toBe(200);
    expect(stopsOf(viewOf(res)).slice(0, 2)).toStrictEqual([
      { orderId: halfway.id, hasLocation: true, state: 'collected' },
      { orderId: byStart.id, hasLocation: true, state: 'toCollect' },
    ]);
  });

  it.each([
    { label: 'the first stop up', index: 0, direction: 'up' },
    { label: 'the last stop down', index: 3, direction: 'down' },
  ] as const)(
    'refuses $label with 409 stop_at_edge, changing nothing',
    async ({ index, direction }) => {
      const { round, stops } = await seedRoutedRound();
      const before = await storedState();

      const res = await moveStopOf(round.id, stops[index].id, { direction });

      expect(res.status).toBe(409);
      expect(res.body).toStrictEqual({ error: 'stop_at_edge', message: ROUND_MESSAGES.stopAtEdge });
      expect(await storedState()).toStrictEqual(before);
    },
  );

  it.each([
    { label: 'no body', body: undefined },
    { label: 'an empty object', body: {} },
    { label: 'another direction', body: { direction: 'left' } },
    { label: 'a direction in capitals', body: { direction: 'UP' } },
    { label: 'an unknown key', body: { direction: 'up', to: 0 } },
    { label: 'an array', body: ['up'] },
  ])('refuses $label with 400 invalid_move, changing nothing', async ({ body }) => {
    const { round, stops } = await seedRoutedRound();
    const before = await storedState();

    const res = await moveStopOf(round.id, stops[1].id, body);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_move' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('checks the body first: an invalid body is a 400 even for an unknown round', async () => {
    const res = await moveStopOf(UNKNOWN_ID, UNKNOWN_ID, { direction: 'sideways' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_move' });
  });

  it('refuses a round still confirming with 409 route_not_open, changing nothing', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_START },
      { status: 'confirmed', street: BY_DROP_OFF },
    ]);
    const [, second] = inRound;
    if (!second) throw new Error();
    const before = await storedState();

    const res = await moveStopOf(round.id, second.id, { direction: 'up' });

    expectRouteNotOpen(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a closed round with 409 route_not_open, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    await rounds.update(round.id, { status: 'closed', closedAt: new Date() });
    const before = await storedState();

    const res = await moveStopOf(round.id, stops[1].id, { direction: 'up' });

    expectRouteNotOpen(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses with 409 route_not_open when the round was closed between the read and the write', async () => {
    const closing = new ClosingRoundsRepo();
    buildApp({ rounds: closing });
    const { round, stops } = await seedRoutedRound();
    closing.closeBeforeConditionalWrite.add(round.id);

    const res = await moveStopOf(round.id, stops[1].id, { direction: 'up' });

    expectRouteNotOpen(res);
    const stored = await storedRound(round.id);
    expect(stored.status).toBe('closed');
    // The move did not land on the closed round.
    expect(stored.stops).toStrictEqual(round.stops);
  });

  it.each([
    { label: 'an order sent back at the build as notConfirmed', which: 'sentBack' },
    { label: 'a stop of another round', which: 'otherRound' },
    { label: 'an unknown order id', which: 'unknown' },
  ] as const)('answers $label with 404 order_not_found, changing nothing', async ({ which }) => {
    const { round, sentBack } = await seedRoutedRound();
    const other = await seedRoundWith([{ status: 'confirmed', street: BY_START }]);
    expect((await buildRoute(other.round.id)).status).toBe(200);
    const orderIds: Record<typeof which, string> = {
      sentBack: sentBack.id,
      otherRound: other.inRound[0]?.id ?? '',
      unknown: UNKNOWN_ID,
    };
    const before = await storedState();

    const res = await moveStopOf(round.id, orderIds[which], { direction: 'up' });

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'order_not_found' });
    expect(await storedState()).toStrictEqual(before);
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers $label with 404 round_not_found, changing nothing', async ({ id }) => {
    const { stops } = await seedRoutedRound();
    const before = await storedState();

    const res = await moveStopOf(id, stops[1].id, { direction: 'up' });

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'round_not_found' });
    expect(await storedState()).toStrictEqual(before);
  });
});

describe('/api/collector/rounds: the login and the Origin check', () => {
  it.each([
    { label: 'GET /', send: () => request(app).get(BASE) },
    { label: 'GET /:id', send: () => request(app).get(`${BASE}/${UNKNOWN_ID}`) },
    {
      label: 'POST /',
      send: () =>
        request(app)
          .post(BASE)
          .send(planBody([UNKNOWN_ID])),
    },
    {
      label: 'POST /:id/orders/:orderId/confirm-by-phone',
      send: () => request(app).post(`${BASE}/${UNKNOWN_ID}/orders/${UNKNOWN_ID}/confirm-by-phone`),
    },
    {
      label: 'POST /:id/route',
      send: () => request(app).post(`${BASE}/${UNKNOWN_ID}/route`),
    },
    {
      label: 'POST /:id/stops/:orderId/move',
      send: () =>
        request(app)
          .post(`${BASE}/${UNKNOWN_ID}/stops/${UNKNOWN_ID}/move`)
          .send({ direction: 'up' }),
    },
  ])('answers $label without a session cookie with 401, changing nothing', async ({ send }) => {
    await seed();
    await seedRound();
    const before = await storedState();

    // From the site itself, so it is the login guard answering, not the Origin check.
    const res = await send().set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('applies the guard to an existing round too: 401 without a cookie reveals nothing', async () => {
    const order = await seed();
    expect((await plan(planBody([order.id]))).status).toBe(201);
    const round = await onlyRound();

    const res = await request(app).get(`${BASE}/${round.id}`).set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(401);
    expect(res.text).not.toContain(order.contact.name);
    expect(res.text).not.toContain(order.id);
  });

  it('refuses a plan from another site with 403 forbidden_origin, even with the cookie', async () => {
    const order = await seed();
    const before = await storedState();

    const res = await request(app)
      .post(BASE)
      .set('Host', TEST_HOST)
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .send(planBody([order.id]));

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a plan with no Origin header with 403 forbidden_origin, even with the cookie', async () => {
    const order = await seed();
    const before = await storedState();

    const res = await request(app)
      .post(BASE)
      .set('Host', TEST_HOST)
      .set('Cookie', cookie)
      .send(planBody([order.id]));

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses "אישר בטלפון" from another site with 403 forbidden_origin, even with the cookie', async () => {
    const order = await seed();
    expect((await plan(planBody([order.id]))).status).toBe(201);
    const round = await onlyRound();
    const before = await storedState();

    const res = await request(app)
      .post(`${BASE}/${round.id}/orders/${order.id}/confirm-by-phone`)
      .set('Host', TEST_HOST)
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses building a route from another site with 403 forbidden_origin, even with the cookie', async () => {
    const order = await seed();
    expect((await plan(planBody([order.id]))).status).toBe(201);
    const round = await onlyRound();
    const before = await storedState();

    const res = await request(app)
      .post(`${BASE}/${round.id}/route`)
      .set('Host', TEST_HOST)
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(await storedState()).toStrictEqual(before);
  });
});

describe('/api/collector/rounds: the Origin check on a move', () => {
  it('refuses moving a stop from another site with 403 forbidden_origin, even with the cookie', async () => {
    const { round, inRound } = await seedRoundWith([
      { status: 'confirmed', street: BY_START },
      { status: 'confirmed', street: BY_DROP_OFF },
    ]);
    const [, second] = inRound;
    if (!second) throw new Error();
    expect((await buildRoute(round.id)).status).toBe(200);
    const before = await storedState();

    const res = await request(app)
      .post(`${BASE}/${round.id}/stops/${second.id}/move`)
      .set('Host', TEST_HOST)
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .send({ direction: 'up' });

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
    expect(await storedState()).toStrictEqual(before);
  });
});

describe('/api/collector/rounds: logs', () => {
  it('log nothing, whatever the answer', async () => {
    const customer = await seed({
      contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
      address: { streetName: 'הרחוב שלי', houseNumber: HOUSE_NUMBER, bottlesSpot: 'privateHouse' },
    });
    const other = await seed();

    const planned = await plan(planBody([customer.id, other.id]));
    const round = await onlyRound();
    const statuses = [
      planned.status,
      (await plan(planBody([customer.id]))).status,
      (await plan(planBody([customer.id], { pickupBy: '25:00' }))).status,
      (await getRounds()).status,
      (await getRound(round.id)).status,
      (await getRound(UNKNOWN_ID)).status,
      (await confirmByPhone(round.id, customer.id)).status,
      (await confirmByPhone(round.id, customer.id)).status,
      (await confirmByPhone(round.id, UNKNOWN_ID)).status,
      (await confirmByPhone(round.id, other.id)).status,
      // Both are free-text streets (no location), so the stops are in plan order: customer, other.
      (await buildRoute(round.id)).status,
      (await buildRoute(round.id)).status,
      (await buildRoute(UNKNOWN_ID)).status,
      (await moveStopOf(round.id, other.id, { direction: 'up' })).status,
      (await moveStopOf(round.id, other.id, { direction: 'up' })).status,
      (await moveStopOf(round.id, customer.id, { direction: 'left' })).status,
      (await moveStopOf(round.id, UNKNOWN_ID, { direction: 'up' })).status,
      (await moveStopOf(UNKNOWN_ID, customer.id, { direction: 'up' })).status,
    ];

    expect(statuses).toStrictEqual([
      201, 409, 400, 200, 200, 404, 200, 200, 404, 200, 200, 409, 404, 200, 409, 400, 404, 404,
    ]);
    // The customer's name and phone did go out, in the message to them: it is the log (console)
    // that must never see them, nor anything else from a body.
    expect(sender.sent[0]).toMatchObject({ to: PHONE_E164, vars: { name: NAME } });
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
