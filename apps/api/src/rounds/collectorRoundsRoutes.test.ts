// Acceptance tests of /api/collector/rounds (spec §3.5 "תכנון סבב", §3.6 step 1 "אישורים")
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
  MAX_ROUND_ORDERS,
  ROUND_MESSAGES,
  ROUND_PLAN_ERRORS,
  roundViewSchema,
  roundsResponseSchema,
  type MessageLogEntry,
  type NewOrder,
  type NewRound,
  type Order,
  type PlanRoundRequest,
  type Round,
  type RoundGroupKey,
  type RoundView,
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
 * An in-memory orders repo where the customer cancels an order at the worst moment: just before a
 * route's conditional write (`ifStatus`) to an id in {@link cancelBeforeConditionalWrite}, the
 * order is cancelled, so the write finds another status and answers null. Unconditional writes
 * (the message log) go through as usual.
 */
class RacingOrdersRepo extends InMemoryOrdersRepo {
  /** Ids of the orders cancelled just before a conditional write. */
  readonly cancelBeforeConditionalWrite = new Set<string>();

  override async update(
    id: string,
    patch: OrderPatch,
    options?: OrderUpdateOptions,
  ): Promise<Order | null> {
    if (options?.ifStatus !== undefined && this.cancelBeforeConditionalWrite.has(id)) {
      const now = new Date();
      await super.update(id, { status: 'cancelled', cancelledAt: now, updatedAt: now });
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
 * Builds the test's app on fresh repos (or on `options.orders`), with its own fake login on the
 * real clock and a session issued now (valid, and too new to renew). Seed AFTER calling it: it
 * replaces the module's `orders` and `rounds`.
 */
function buildApp(options: { orders?: InMemoryOrdersRepo; messageSender?: MessageSender } = {}) {
  orders = options.orders ?? new InMemoryOrdersRepo();
  rounds = new InMemoryRoundsRepo();
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
    ];

    expect(statuses).toStrictEqual([201, 409, 400, 200, 200, 404, 200, 200, 404]);
    // The customer's name and phone did go out, in the message to them: it is the log (console)
    // that must never see them, nor anything else from a body.
    expect(sender.sent[0]).toMatchObject({ to: PHONE_E164, vars: { name: NAME } });
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
