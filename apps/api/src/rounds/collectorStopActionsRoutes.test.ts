// Acceptance tests of the stop actions under /api/collector/rounds (spec §3.6 step 2: "אספתי" and
// "לא נמצא")
// through supertest against createApp(fakes): no listen(), no port, no database, no network. Each
// test keeps the in-memory repos and the FakeSender it passes in, seeds a routed round directly
// (makeNewRound with its stops, and confirmed orders in it), and reads back what the route stored
// and sent. Requests carry a valid session cookie and come from the site's own origin
// (SAME_ORIGIN_HEADERS), except in the guard's and the Origin check's own tests.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  COLLECTOR_ORDER_MESSAGES,
  COLLECT_STOP_ERRORS,
  MAX_BOTTLES,
  ROUND_MESSAGES,
  roundViewSchema,
  type MessageLogEntry,
  type NewOrder,
  type NewRound,
  type Order,
  type Round,
  type RoundView,
} from '@bottlerun/shared';
import { createApp } from '../app.ts';
import { loggedInCookie } from '../auth/testSession.ts';
import { createFakeAuth, createFakeDeps, createFakeMessaging } from '../fakeDeps.ts';
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

/** What each seeded customer estimated; the tests' corrected count differs from it. */
const ESTIMATE = 60;

// A customer's data. Distinctive values, so "the log does not contain it" cannot pass or fail by
// accident. The phone starts 054, never the 050 of makeNewOrder's phones.
const NAME = 'רבקה לוינסון';
const PHONE_E164 = '+972547654321';
const HOUSE_NUMBER = '17ב';

/** A confirmation request already sent as a wa.me link (ADR-0003), for orders seeded in a round. */
const MANUAL_REQUEST: MessageLogEntry = {
  kind: 'confirmRequest',
  at: new Date('2026-11-11T17:00:00.000Z'),
  mode: 'manual',
  url: 'https://wa.me/972500000000?text=confirm',
};

/**
 * An in-memory orders repo where something happens to the order at the worst moment: just before
 * a conditional write (`ifStatus`) to an id in {@link collectBeforeConditionalWrite}, the order is
 * collected (the other tap of a double tap won); to an id in {@link notFoundBeforeConditionalWrite},
 * it is marked not found in the mapped round (the other tap of a "לא נמצא" double tap won); to an
 * id in {@link cancelBeforeConditionalWrite}, it is cancelled (the customer's cancel). Either way
 * the write finds another status and answers null. Unconditional writes (the message log) go
 * through as usual.
 */
class RacingOrdersRepo extends InMemoryOrdersRepo {
  readonly collectBeforeConditionalWrite = new Set<string>();
  readonly notFoundBeforeConditionalWrite = new Map<string, Round>();
  readonly cancelBeforeConditionalWrite = new Set<string>();

  override async update(
    id: string,
    patch: OrderPatch,
    options?: OrderUpdateOptions,
  ): Promise<Order | null> {
    if (options?.ifStatus !== undefined) {
      const now = new Date();
      const notFoundIn = this.notFoundBeforeConditionalWrite.get(id);
      if (this.collectBeforeConditionalWrite.has(id)) {
        await super.update(id, {
          status: 'collected',
          bottlesCollected: 33,
          collectedAt: now,
          updatedAt: now,
        });
      } else if (notFoundIn !== undefined) {
        await super.update(id, {
          status: 'waiting',
          roundId: undefined,
          lastMiss: { date: notFoundIn.date, reason: 'notFound', roundId: notFoundIn.id },
          updatedAt: now,
        });
      } else if (this.cancelBeforeConditionalWrite.has(id)) {
        await super.update(id, { status: 'cancelled', cancelledAt: now, updatedAt: now });
      }
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
 * Builds the test's app on fresh repos (or on `options.orders`), with its own fake login and a
 * session issued now. Seed AFTER calling it: it replaces the module's `orders` and `rounds`.
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

/**
 * Stores a routed, open round (unless overridden) whose route is one stop per entry, in that
 * order, each a confirmed order in the round (estimate {@link ESTIMATE}, its confirmation request
 * already sent) with the entry's overrides on top. `notAStop` orders are in the round's
 * `orderIds` but in no stop, like one the build sent back.
 */
async function seedRoutedRound(
  entries: Partial<NewOrder>[] = [{}],
  options: { round?: Partial<NewRound>; notAStop?: Partial<NewOrder>[] } = {},
): Promise<{ round: Round; stops: Order[]; notAStop: Order[] }> {
  const created = await rounds.create(makeNewRound({ phase: 'routed', ...options.round }));
  const inRound = (overrides: Partial<NewOrder>) =>
    orders.create(
      makeNewOrder({
        status: 'confirmed',
        roundId: created.id,
        bottlesEstimated: ESTIMATE,
        messages: [MANUAL_REQUEST],
        ...overrides,
      }),
    );
  const stops: Order[] = [];
  for (const overrides of entries) stops.push(await inRound(overrides));
  const notAStop: Order[] = [];
  for (const overrides of options.notAStop ?? []) notAStop.push(await inRound(overrides));
  const round = await rounds.update(created.id, {
    orderIds: [...stops, ...notAStop].map((order) => order.id),
    stops: stops.map((order) => ({ orderId: order.id, hasLocation: false })),
  });
  if (round === null) throw new Error('the round just stored is gone');
  return { round, stops, notAStop };
}

/** The first stop of a seeded round; fails the test when there is none. */
function first(stops: Order[]): Order {
  const [stop] = stops;
  if (stop === undefined) throw new Error('the round has no stop');
  return stop;
}

/** The stored order with this id; fails the test when there is none. */
async function storedOrder(id: string): Promise<Order> {
  const order = await orders.findById(id);
  if (order === null) throw new Error('no stored order has this id');
  return order;
}

/** Everything a refused request must leave as it was: orders, rounds, and messages sent. */
async function storedState(): Promise<{ orders: Order[]; rounds: Round[]; sent: number }> {
  return { orders: await orders.list(), rounds: await rounds.list(), sent: sender.sent.length };
}

/** "אספתי" on the stop of `orderId`; `body` left out sends no body at all. */
function collect(roundId: string, orderId: string, body?: unknown): request.Test {
  const req = request(app)
    .post(`${BASE}/${roundId}/stops/${orderId}/collected`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
  return body === undefined ? req : req.send(body as object);
}

/** "לא נמצא" on the stop of `orderId`; `body` left out sends no body at all. */
function notFound(roundId: string, orderId: string, body?: unknown): request.Test {
  const req = request(app)
    .post(`${BASE}/${roundId}/stops/${orderId}/not-found`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
  return body === undefined ? req : req.send(body as object);
}

function getRound(id: string): request.Test {
  return request(app).get(`${BASE}/${id}`).set('Cookie', cookie);
}

/** The round's view in a 200 body, checked against the shared contract the web app parses. */
function viewOf(res: request.Response): RoundView {
  return roundViewSchema.parse(res.body);
}

/** The view's stop of `orderId`; fails the test when there is none. */
function stopOf(view: RoundView, orderId: string): RoundView['stops'][number] {
  const stop = view.stops.find((s) => s.order.id === orderId);
  if (stop === undefined) throw new Error('the view has no stop for this order');
  return stop;
}

/** The thank-you entries of an order's message log. */
function thankYous(order: Order): MessageLogEntry[] {
  return order.messages.filter((entry) => entry.kind === 'thankYou');
}

/** Expects `date` to be inside [before, after]: a time the route took from the real clock. */
function expectBetween(date: Date | undefined, before: Date, after: Date): void {
  expect(date).toBeInstanceOf(Date);
  expect(date?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(date?.getTime()).toBeLessThanOrEqual(after.getTime());
}

function expectRouteNotOpen(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({ error: 'route_not_open', message: ROUND_MESSAGES.routeNotOpen });
}

function expectStopHandled(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({ error: 'stop_handled', message: ROUND_MESSAGES.stopHandled });
}

function expectInvalidTransition(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({
    error: 'invalid_transition',
    message: COLLECTOR_ORDER_MESSAGES.orderClosed,
  });
}

describe('POST /api/collector/rounds/:id/stops/:orderId/collected: "אספתי"', () => {
  it('collects the stop with the corrected count, sends one thank-you and answers the view', async () => {
    const { round, stops } = await seedRoutedRound([{}, {}]);
    const [stop, other] = stops;
    if (!stop || !other) throw new Error();

    const before = new Date();
    const res = await collect(round.id, stop.id, { bottlesCollected: 42 });
    const after = new Date();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const stored = await storedOrder(stop.id);
    expect(stored).toMatchObject({
      status: 'collected',
      bottlesCollected: 42,
      bottlesEstimated: ESTIMATE,
      roundId: round.id,
    });
    expectBetween(stored.collectedAt, before, after);
    // One thank-you, to the customer, logged after the confirmation request.
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      kind: 'thankYou',
      orderId: stop.id,
      to: stop.contact.phone,
    });
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages[0]).toStrictEqual(MANUAL_REQUEST);
    const [logged] = thankYous(stored);
    expect(logged).toMatchObject({ kind: 'thankYou', mode: 'manual' });
    expectBetween(logged?.at, before, after);

    const view = viewOf(res);
    expect(view.round).toMatchObject({ id: round.id, status: 'open', phase: 'routed' });
    expect(stopOf(view, stop.id)).toMatchObject({
      state: 'collected',
      thankYou: {
        orderId: stop.id,
        messageIndex: 1,
        kind: 'thankYou',
        name: stop.contact.name,
        url: logged?.mode === 'manual' ? logged.url : 'missing',
      },
    });
    // The other stop is untouched, and has no thank-you row.
    expect(stopOf(view, other.id).state).toBe('toCollect');
    expect(stopOf(view, other.id)).not.toHaveProperty('thankYou');
    expect(await storedOrder(other.id)).toStrictEqual(other);
    // The round itself is not written: a stop's state is derived from its order.
    expect(await rounds.findById(round.id)).toStrictEqual(round);
    // GET /:id answers the same: the collect is stored, not only answered.
    expect((await getRound(round.id)).body).toStrictEqual(res.body);
  });

  it('with the real WaMeLinkSender, the collected stop carries the logged wa.me link', async () => {
    buildApp({ messageSender: new WaMeLinkSender() });
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);

    const res = await collect(round.id, stop.id, { bottlesCollected: 42 });

    expect(res.status).toBe(200);
    const [logged] = thankYous(await storedOrder(stop.id));
    if (logged?.mode !== 'manual') throw new Error('the thank-you was not logged as a wa.me link');
    expect(logged.url.startsWith(`https://wa.me/${stop.contact.phone.slice(1)}?text=`)).toBe(true);
    expect(stopOf(viewOf(res), stop.id).thankYou?.url).toBe(logged.url);
  });

  it.each([
    { label: 'no body', body: undefined },
    { label: 'an empty object', body: {} },
  ])('takes the estimate as the count with $label', async ({ body }) => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);

    const res = await collect(round.id, stop.id, body);

    expect(res.status).toBe(200);
    expect(await storedOrder(stop.id)).toMatchObject({
      status: 'collected',
      bottlesCollected: ESTIMATE,
    });
  });

  it('accepts a count below the 20-bottle booking minimum', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);

    const res = await collect(round.id, stop.id, { bottlesCollected: 5 });

    expect(res.status).toBe(200);
    expect((await storedOrder(stop.id)).bottlesCollected).toBe(5);
  });

  it('answers a second tap with 200 and changes nothing: one thank-you, the first count stands', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    const firstTap = await collect(round.id, stop.id, { bottlesCollected: 42 });
    expect(firstTap.status).toBe(200);
    const before = await storedState();

    const res = await collect(round.id, stop.id, { bottlesCollected: 50 });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(firstTap.body);
    expect(await storedState()).toStrictEqual(before);
    expect(sender.sent).toHaveLength(1);
    const stored = await storedOrder(stop.id);
    expect(stored.bottlesCollected).toBe(42);
    expect(thankYous(stored)).toHaveLength(1);
  });

  it('answers the double tap that lost the race with 200, sending no second thank-you', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    racing.collectBeforeConditionalWrite.add(stop.id);

    const res = await collect(round.id, stop.id, { bottlesCollected: 42 });

    expect(res.status).toBe(200);
    expect(stopOf(viewOf(res), stop.id).state).toBe('collected');
    // The winner's count stands, and this tap sent nothing.
    expect((await storedOrder(stop.id)).bottlesCollected).toBe(33);
    expect(sender.sent).toHaveLength(0);
  });

  it('refuses with 409 invalid_transition when the customer cancelled between the read and the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    racing.cancelBeforeConditionalWrite.add(stop.id);

    const res = await collect(round.id, stop.id, { bottlesCollected: 42 });

    expectInvalidTransition(res);
    const stored = await storedOrder(stop.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.bottlesCollected).toBeUndefined();
    expect(sender.sent).toHaveLength(0);
  });

  it('still collects when the sender throws: 200, the thank-you logged as failed, no "שלח תודה" row', async () => {
    buildApp({
      messageSender: new FakeSender(() => {
        throw new Error('the sender broke');
      }),
    });
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);

    const res = await collect(round.id, stop.id, { bottlesCollected: 42 });

    expect(res.status).toBe(200);
    const stored = await storedOrder(stop.id);
    expect(stored).toMatchObject({ status: 'collected', bottlesCollected: 42 });
    expect(thankYous(stored)).toStrictEqual([
      expect.objectContaining({ kind: 'thankYou', mode: 'failed', reason: 'sender_error' }),
    ]);
    const view = stopOf(viewOf(res), stop.id);
    expect(view.state).toBe('collected');
    expect(view).not.toHaveProperty('thankYou');
  });

  it.each([
    { label: '0', body: { bottlesCollected: 0 }, message: COLLECT_STOP_ERRORS.bottlesInvalid },
    {
      label: 'a negative',
      body: { bottlesCollected: -3 },
      message: COLLECT_STOP_ERRORS.bottlesInvalid,
    },
    {
      label: 'a fraction',
      body: { bottlesCollected: 2.5 },
      message: COLLECT_STOP_ERRORS.bottlesInvalid,
    },
    {
      label: 'a string',
      body: { bottlesCollected: '40' },
      message: COLLECT_STOP_ERRORS.bottlesInvalid,
    },
    {
      label: 'null',
      body: { bottlesCollected: null },
      message: COLLECT_STOP_ERRORS.bottlesInvalid,
    },
    {
      label: 'more than the maximum',
      body: { bottlesCollected: MAX_BOTTLES + 1 },
      message: COLLECT_STOP_ERRORS.bottlesTooMany,
    },
  ])(
    'refuses $label with 400 invalid_collect and the field message, changing nothing',
    async ({ body, message }) => {
      const { round, stops } = await seedRoutedRound();
      const before = await storedState();

      const res = await collect(round.id, first(stops).id, body);

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({
        error: 'invalid_collect',
        fieldErrors: { bottlesCollected: message },
      });
      expect(await storedState()).toStrictEqual(before);
    },
  );

  it.each([
    { label: 'an unknown key', body: { bottlesCollected: 40, note: 'x' } },
    { label: 'an array', body: [40] },
  ])(
    'refuses $label with 400 invalid_collect and no field message, changing nothing',
    async ({ body }) => {
      const { round, stops } = await seedRoutedRound();
      const before = await storedState();

      const res = await collect(round.id, first(stops).id, body);

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({ error: 'invalid_collect', fieldErrors: {} });
      expect(await storedState()).toStrictEqual(before);
    },
  );

  it('checks the body first: an invalid body is a 400 even for an unknown round', async () => {
    const res = await collect(UNKNOWN_ID, UNKNOWN_ID, { bottlesCollected: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_collect' });
  });

  it('refuses a round still confirming with 409 route_not_open, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound([{}], { round: { phase: 'confirming' } });
    const before = await storedState();

    const res = await collect(round.id, first(stops).id, { bottlesCollected: 42 });

    expectRouteNotOpen(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a closed round with 409 route_not_open, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    await rounds.update(round.id, { status: 'closed', closedAt: new Date() });
    const before = await storedState();

    const res = await collect(round.id, first(stops).id, { bottlesCollected: 42 });

    expectRouteNotOpen(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it.each([
    { label: 'an order of the round that is no stop', which: 'notAStop' },
    { label: 'a stop of another round', which: 'otherRound' },
    { label: 'an unknown order id', which: 'unknown' },
    { label: 'a malformed order id', which: 'malformed' },
  ] as const)('answers $label with 404 order_not_found, changing nothing', async ({ which }) => {
    const { round, notAStop } = await seedRoutedRound([{}], { notAStop: [{ status: 'pending' }] });
    const other = await seedRoutedRound();
    const orderIds: Record<typeof which, string> = {
      notAStop: first(notAStop).id,
      otherRound: first(other.stops).id,
      unknown: UNKNOWN_ID,
      malformed: MALFORMED_ID,
    };
    const before = await storedState();

    const res = await collect(round.id, orderIds[which], { bottlesCollected: 42 });

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

    const res = await collect(id, first(stops).id, { bottlesCollected: 42 });

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'round_not_found' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a cancelled stop with 409 stop_handled, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound([
      { status: 'cancelled', cancelledAt: new Date('2026-11-12T07:00:00.000Z') },
    ]);
    const before = await storedState();

    const res = await collect(round.id, first(stops).id, { bottlesCollected: 42 });

    expectStopHandled(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a stop not found with 409 stop_handled, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    await orders.update(stop.id, {
      status: 'waiting',
      roundId: undefined,
      lastMiss: { date: round.date, reason: 'notFound', roundId: round.id },
      updatedAt: new Date(),
    });
    const before = await storedState();

    const res = await collect(round.id, stop.id, { bottlesCollected: 42 });

    expectStopHandled(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a stop that left the round with 409 stop_handled, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    await orders.update(stop.id, {
      status: 'waiting',
      roundId: undefined,
      lastMiss: { date: round.date, reason: 'addressChanged', roundId: round.id },
      updatedAt: new Date(),
    });
    const before = await storedState();

    const res = await collect(round.id, stop.id, { bottlesCollected: 42 });

    expectStopHandled(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a pending stop with 409 invalid_transition, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound([{ status: 'pending' }]);
    const before = await storedState();

    const res = await collect(round.id, first(stops).id, { bottlesCollected: 42 });

    expectInvalidTransition(res);
    expect(await storedState()).toStrictEqual(before);
  });
});

describe('POST /api/collector/rounds/:id/stops/:orderId/collected: the login and the Origin check', () => {
  it('answers without a session cookie with 401, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    const before = await storedState();

    // From the site itself, so it is the login guard answering, not the Origin check.
    const res = await request(app)
      .post(`${BASE}/${round.id}/stops/${first(stops).id}/collected`)
      .set(SAME_ORIGIN_HEADERS)
      .send({ bottlesCollected: 42 });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
    expect(await storedState()).toStrictEqual(before);
  });

  it.each([
    { label: 'from another site', origin: 'https://evil.example' },
    { label: 'with no Origin header', origin: undefined },
  ])(
    'refuses a collect $label with 403 forbidden_origin, even with the cookie',
    async ({ origin }) => {
      const { round, stops } = await seedRoutedRound();
      const before = await storedState();

      const req = request(app)
        .post(`${BASE}/${round.id}/stops/${first(stops).id}/collected`)
        .set('Host', TEST_HOST)
        .set('Cookie', cookie);
      const res = await (origin === undefined ? req : req.set('Origin', origin)).send({
        bottlesCollected: 42,
      });

      expect(res.status).toBe(403);
      expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
      expect(await storedState()).toStrictEqual(before);
    },
  );
});

describe('POST /api/collector/rounds/:id/stops/:orderId/collected: logs', () => {
  it('logs nothing, whatever the answer', async () => {
    const { round, stops } = await seedRoutedRound([
      {
        contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
        address: {
          streetName: 'הרחוב שלי',
          houseNumber: HOUSE_NUMBER,
          bottlesSpot: 'privateHouse',
        },
      },
      { status: 'cancelled', cancelledAt: new Date() },
    ]);
    const [customer, cancelled] = stops;
    if (!customer || !cancelled) throw new Error();

    const statuses = [
      (await collect(round.id, customer.id, { bottlesCollected: 42 })).status,
      (await collect(round.id, customer.id, { bottlesCollected: 43 })).status,
      (await collect(round.id, customer.id, { bottlesCollected: 0 })).status,
      (await collect(round.id, customer.id, { phone: PHONE_E164 })).status,
      (await collect(round.id, cancelled.id)).status,
      (await collect(round.id, UNKNOWN_ID)).status,
      (await collect(UNKNOWN_ID, customer.id)).status,
    ];

    expect(statuses).toStrictEqual([200, 200, 400, 400, 409, 404, 404]);
    // The customer's name and phone did go out, in the thank-you to them: it is the log (console)
    // that must never see them, nor anything else from a body.
    expect(sender.sent[0]).toMatchObject({ to: PHONE_E164, vars: { name: NAME } });
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /api/collector/rounds/:id/stops/:orderId/not-found: "לא נמצא"', () => {
  it('sends the order back to waiting, keeps the stop in the route as notFound, and sends nothing', async () => {
    const { round, stops } = await seedRoutedRound([{}, {}]);
    const [stop, other] = stops;
    if (!stop || !other) throw new Error();

    const before = new Date();
    const res = await notFound(round.id, stop.id);
    const after = new Date();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const stored = await storedOrder(stop.id);
    expect(stored.status).toBe('waiting');
    expect(stored.roundId).toBeUndefined();
    expect(stored.lastMiss).toStrictEqual({
      date: round.date,
      reason: 'notFound',
      roundId: round.id,
    });
    expectBetween(stored.updatedAt, before, after);
    // Nothing else of the order changes: its message log is the confirmation request alone.
    expect(stored.messages).toStrictEqual([MANUAL_REQUEST]);
    expect(stored.bottlesCollected).toBeUndefined();
    // No message: "לא נמצא" sends nothing to the customer.
    expect(sender.sent).toHaveLength(0);

    const view = viewOf(res);
    expect(view.round).toMatchObject({ id: round.id, status: 'open', phase: 'routed' });
    // The stop stays in the route, in its place, shown as handled.
    expect(view.stops.map((s) => s.order.id)).toStrictEqual([stop.id, other.id]);
    expect(stopOf(view, stop.id).state).toBe('notFound');
    expect(stopOf(view, stop.id)).not.toHaveProperty('thankYou');
    expect(stopOf(view, other.id).state).toBe('toCollect');
    // It is in none of the confirmation step's groups.
    for (const group of view.groups) {
      expect(group.orders.map((o) => o.id)).not.toContain(stop.id);
    }
    expect(await storedOrder(other.id)).toStrictEqual(other);
    // The round itself is not written: it still holds the order and its stop.
    expect(await rounds.findById(round.id)).toStrictEqual(round);
    // GET /:id answers the same: the change is stored, not only answered.
    expect((await getRound(round.id)).body).toStrictEqual(res.body);
  });

  it('answers a second tap with 200 and writes nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    const firstTap = await notFound(round.id, stop.id);
    expect(firstTap.status).toBe(200);
    const before = await storedState();

    const res = await notFound(round.id, stop.id);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(firstTap.body);
    // Deep-equal state includes every order's updatedAt: the second tap wrote nothing.
    expect(await storedState()).toStrictEqual(before);
    expect(sender.sent).toHaveLength(0);
  });

  it('sends a pending stop back to waiting as well', async () => {
    const { round, stops } = await seedRoutedRound([{ status: 'pending' }]);
    const stop = first(stops);

    const res = await notFound(round.id, stop.id);

    expect(res.status).toBe(200);
    const stored = await storedOrder(stop.id);
    expect(stored.status).toBe('waiting');
    expect(stored.roundId).toBeUndefined();
    expect(stored.lastMiss).toStrictEqual({
      date: round.date,
      reason: 'notFound',
      roundId: round.id,
    });
    expect(stopOf(viewOf(res), stop.id).state).toBe('notFound');
  });

  it('ignores a body', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);

    const res = await notFound(round.id, stop.id, { bottlesCollected: 0 });

    expect(res.status).toBe(200);
    expect(stopOf(viewOf(res), stop.id).state).toBe('notFound');
  });

  it.each([
    {
      label: 'a collected stop',
      overrides: {
        status: 'collected',
        bottlesCollected: 40,
        collectedAt: new Date('2026-11-12T07:00:00.000Z'),
      },
    },
    {
      label: 'a cancelled stop',
      overrides: { status: 'cancelled', cancelledAt: new Date('2026-11-12T07:00:00.000Z') },
    },
  ] satisfies { label: string; overrides: Partial<NewOrder> }[])(
    'refuses $label with 409 stop_handled, changing nothing',
    async ({ overrides }) => {
      const { round, stops } = await seedRoutedRound([overrides]);
      const before = await storedState();

      const res = await notFound(round.id, first(stops).id);

      expectStopHandled(res);
      expect(await storedState()).toStrictEqual(before);
    },
  );

  it('refuses a stop that left the round with 409 stop_handled, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    await orders.update(stop.id, {
      status: 'waiting',
      roundId: undefined,
      lastMiss: { date: round.date, reason: 'addressChanged', roundId: round.id },
      updatedAt: new Date(),
    });
    const before = await storedState();

    const res = await notFound(round.id, stop.id);

    expectStopHandled(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it.each([
    { label: 'an order of the round that is no stop', which: 'notAStop' },
    { label: 'a stop of another round', which: 'otherRound' },
    { label: 'an unknown order id', which: 'unknown' },
    { label: 'a malformed order id', which: 'malformed' },
  ] as const)('answers $label with 404 order_not_found, changing nothing', async ({ which }) => {
    const { round, notAStop } = await seedRoutedRound([{}], { notAStop: [{ status: 'pending' }] });
    const other = await seedRoutedRound();
    const orderIds: Record<typeof which, string> = {
      notAStop: first(notAStop).id,
      otherRound: first(other.stops).id,
      unknown: UNKNOWN_ID,
      malformed: MALFORMED_ID,
    };
    const before = await storedState();

    const res = await notFound(round.id, orderIds[which]);

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

    const res = await notFound(id, first(stops).id);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'round_not_found' });
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a round still confirming with 409 route_not_open, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound([{}], { round: { phase: 'confirming' } });
    const before = await storedState();

    const res = await notFound(round.id, first(stops).id);

    expectRouteNotOpen(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses a closed round with 409 route_not_open, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    await rounds.update(round.id, { status: 'closed', closedAt: new Date() });
    const before = await storedState();

    const res = await notFound(round.id, first(stops).id);

    expectRouteNotOpen(res);
    expect(await storedState()).toStrictEqual(before);
  });

  it('answers the double tap that lost the race with 200', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    racing.notFoundBeforeConditionalWrite.set(stop.id, round);

    const res = await notFound(round.id, stop.id);

    expect(res.status).toBe(200);
    expect(stopOf(viewOf(res), stop.id).state).toBe('notFound');
    expect(sender.sent).toHaveLength(0);
  });

  it('refuses with 409 invalid_transition when the customer cancelled between the read and the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    racing.cancelBeforeConditionalWrite.add(stop.id);

    const res = await notFound(round.id, stop.id);

    expectInvalidTransition(res);
    const stored = await storedOrder(stop.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.roundId).toBe(round.id);
    expect(stored.lastMiss).toBeUndefined();
    expect(sender.sent).toHaveLength(0);
  });

  it('leaves the order plannable into a new round, and the old route still shows it not found', async () => {
    const { round, stops } = await seedRoutedRound();
    const stop = first(stops);
    expect((await notFound(round.id, stop.id)).status).toBe(200);

    const planned = await request(app)
      .post(BASE)
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send({ date: '2026-11-19', region: 'ramat', orderIds: [stop.id] });

    expect(planned.status).toBe(201);
    const newRoundId = viewOf(planned).round.id;
    expect(await storedOrder(stop.id)).toMatchObject({ status: 'pending', roundId: newRoundId });
    // The old round's route still records what happened at its stop.
    const oldView = await getRound(round.id);
    expect(oldView.status).toBe(200);
    expect(stopOf(viewOf(oldView), stop.id).state).toBe('notFound');
  });
});

describe('POST /api/collector/rounds/:id/stops/:orderId/not-found: the login and the Origin check', () => {
  it('answers without a session cookie with 401, changing nothing', async () => {
    const { round, stops } = await seedRoutedRound();
    const before = await storedState();

    // From the site itself, so it is the login guard answering, not the Origin check.
    const res = await request(app)
      .post(`${BASE}/${round.id}/stops/${first(stops).id}/not-found`)
      .set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
    expect(await storedState()).toStrictEqual(before);
  });

  it.each([
    { label: 'from another site', origin: 'https://evil.example' },
    { label: 'with no Origin header', origin: undefined },
  ])(
    'refuses a not-found $label with 403 forbidden_origin, even with the cookie',
    async ({ origin }) => {
      const { round, stops } = await seedRoutedRound();
      const before = await storedState();

      const req = request(app)
        .post(`${BASE}/${round.id}/stops/${first(stops).id}/not-found`)
        .set('Host', TEST_HOST)
        .set('Cookie', cookie);
      const res = await (origin === undefined ? req : req.set('Origin', origin));

      expect(res.status).toBe(403);
      expect(res.body).toStrictEqual({ error: 'forbidden_origin' });
      expect(await storedState()).toStrictEqual(before);
    },
  );
});

describe('POST /api/collector/rounds/:id/stops/:orderId/not-found: logs', () => {
  it('logs nothing, whatever the answer', async () => {
    const { round, stops } = await seedRoutedRound([
      {
        contact: { name: NAME, phone: PHONE_E164, method: 'whatsapp' },
        address: {
          streetName: 'הרחוב שלי',
          houseNumber: HOUSE_NUMBER,
          bottlesSpot: 'privateHouse',
        },
      },
      { status: 'cancelled', cancelledAt: new Date() },
    ]);
    const [customer, cancelled] = stops;
    if (!customer || !cancelled) throw new Error();

    const statuses = [
      // A body holding a phone is ignored, and never logged.
      (await notFound(round.id, customer.id, { phone: PHONE_E164 })).status,
      (await notFound(round.id, customer.id)).status,
      (await notFound(round.id, cancelled.id)).status,
      (await notFound(round.id, UNKNOWN_ID)).status,
      (await notFound(UNKNOWN_ID, customer.id)).status,
    ];

    expect(statuses).toStrictEqual([200, 200, 409, 404, 404]);
    expect(sender.sent).toHaveLength(0);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
