// Acceptance tests of "סגור סבב", POST /api/collector/rounds/:id/close (spec §3.6, §4), through
// supertest against createApp(fakes): no listen(), no port, no database, no network. Each test
// keeps the in-memory repos and the FakeSender it passes in, seeds a round and its orders directly
// (makeNewRound, makeNewOrder), and reads back what the close stored. Requests carry a valid
// session cookie and come from the site's own origin (SAME_ORIGIN_HEADERS), except in the login
// guard's test. The races are played by repos that change a record at the worst moment.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_ORDER_MESSAGES,
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
import { InMemoryOrdersRepo } from '../orders/inMemoryOrdersRepo.ts';
import { makeNewOrder } from '../orders/makeOrder.ts';
import type { OrderPatch, OrderUpdateOptions } from '../orders/ordersRepo.ts';
import { SAME_ORIGIN_HEADERS } from '../testRequest.ts';
import { InMemoryRoundsRepo } from './inMemoryRoundsRepo.ts';
import { makeNewRound } from './makeRound.ts';
import type { RoundPatch, RoundUpdateOptions } from './roundsRepo.ts';

const BASE = '/api/collector/rounds';
/** Shaped like a Mongo ObjectId, but no round has it. */
const UNKNOWN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MALFORMED_ID = 'not-an-id';

/** When an "already closed" round was closed, long before the test runs. */
const EARLIER_CLOSE = new Date('2026-11-12T18:00:00.000Z');

/** A confirmation request already sent as a wa.me link (ADR-0003), for orders seeded in a round. */
const MANUAL_REQUEST: MessageLogEntry = {
  kind: 'confirmRequest',
  at: new Date('2026-11-11T17:00:00.000Z'),
  mode: 'manual',
  url: 'https://wa.me/972500000000?text=confirm',
};

/**
 * An in-memory orders repo where something happens to an order at the worst moment: just before
 * a conditional write (`ifStatus`) to an id in {@link collectBeforeConditionalWrite}, the order is
 * collected ("אספתי" on another screen won); to an id in {@link confirmOnceBeforeConditionalWrite},
 * it is confirmed, once (the customer's confirm). The write then finds another status and answers
 * null. Unconditional writes go through as usual.
 */
class RacingOrdersRepo extends InMemoryOrdersRepo {
  readonly collectBeforeConditionalWrite = new Set<string>();
  readonly confirmOnceBeforeConditionalWrite = new Set<string>();

  override async update(
    id: string,
    patch: OrderPatch,
    options?: OrderUpdateOptions,
  ): Promise<Order | null> {
    if (options?.ifStatus !== undefined) {
      const now = new Date();
      if (this.collectBeforeConditionalWrite.has(id)) {
        await super.update(id, {
          status: 'collected',
          bottlesCollected: 33,
          collectedAt: now,
          updatedAt: now,
        });
      } else if (this.confirmOnceBeforeConditionalWrite.delete(id)) {
        await super.update(id, { status: 'confirmed', updatedAt: now });
      }
    }
    return super.update(id, patch, options);
  }
}

/**
 * An in-memory rounds repo where the round changes under the close: before the first
 * conditional write to an id in {@link routeOnceBeforeConditionalWrite}, the round is routed
 * ("סגור אישורים ובנה מסלול" on another screen won); when {@link alwaysMissConditionalWrites} is
 * set, every conditional write misses, as if something kept changing the round.
 */
class RacingRoundsRepo extends InMemoryRoundsRepo {
  readonly routeOnceBeforeConditionalWrite = new Map<string, RoundPatch>();
  alwaysMissConditionalWrites = false;

  override async update(
    id: string,
    patch: RoundPatch,
    options?: RoundUpdateOptions,
  ): Promise<Round | null> {
    const conditional = options?.ifStatus !== undefined || options?.ifPhase !== undefined;
    if (conditional && this.alwaysMissConditionalWrites) return null;
    const routing = this.routeOnceBeforeConditionalWrite.get(id);
    if (conditional && routing !== undefined) {
      this.routeOnceBeforeConditionalWrite.delete(id);
      await super.update(id, routing);
    }
    return super.update(id, patch, options);
  }
}

let orders: InMemoryOrdersRepo;
let rounds: InMemoryRoundsRepo;
let sender: FakeSender;
let app: Express;
let cookie: string;

/**
 * Builds the test's app on fresh repos (or on the racing ones given), with its own fake login and
 * a session issued now. Seed AFTER calling it: it replaces the module's `orders` and `rounds`.
 */
function buildApp(options: { orders?: InMemoryOrdersRepo; rounds?: InMemoryRoundsRepo } = {}) {
  orders = options.orders ?? new InMemoryOrdersRepo();
  rounds = options.rounds ?? new InMemoryRoundsRepo();
  sender = new FakeSender();
  const auth = createFakeAuth();
  app = createApp(
    createFakeDeps({ orders, rounds, auth, messaging: createFakeMessaging({ sender }) }),
  );
  cookie = loggedInCookie(auth, new Date());
}

beforeEach(() => {
  buildApp();
  // The app's error handler logs a 500; keep the test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An order of a seeded round: its overrides, or overrides built from the round just stored. */
type OrderEntry = Partial<NewOrder> | ((round: Round) => Partial<NewOrder>);

/**
 * Stores a round (open and confirming unless overridden) with one order per entry, in plan order:
 * each `confirmed` in the round, its confirmation request sent, with the entry's overrides on top.
 * With `routed`, the round is in phase `routed` and every entry is also a stop of its route, in
 * the same order.
 */
async function seedRound(
  entries: OrderEntry[],
  options: { round?: Partial<NewRound>; routed?: boolean } = {},
): Promise<{ round: Round; orders: Order[] }> {
  const created = await rounds.create(
    makeNewRound({ phase: options.routed === true ? 'routed' : 'confirming', ...options.round }),
  );
  const seeded: Order[] = [];
  for (const entry of entries) {
    const overrides = typeof entry === 'function' ? entry(created) : entry;
    seeded.push(
      await orders.create(
        makeNewOrder({
          status: 'confirmed',
          roundId: created.id,
          messages: [MANUAL_REQUEST],
          ...overrides,
        }),
      ),
    );
  }
  const round = await rounds.update(created.id, {
    orderIds: seeded.map((order) => order.id),
    stops:
      options.routed === true
        ? seeded.map((order) => ({ orderId: order.id, hasLocation: true }))
        : [],
  });
  if (round === null) throw new Error('the round just stored is gone');
  return { round, orders: seeded };
}

/** A stop "לא נמצא" earlier in this round: back to waiting, out of the round. */
function notFoundIn(round: Round): Partial<NewOrder> {
  return {
    status: 'waiting',
    roundId: undefined,
    lastMiss: { date: round.date, reason: 'notFound', roundId: round.id },
  };
}

/** An order whose customer tapped "לא מתאים הפעם" in this round. */
function askedOtherDateIn(round: Round): Partial<NewOrder> {
  return {
    status: 'waiting',
    roundId: undefined,
    lastMiss: { date: round.date, reason: 'askedOtherDate', roundId: round.id },
  };
}

const COLLECTED: Partial<NewOrder> = {
  status: 'collected',
  bottlesCollected: 55,
  collectedAt: new Date('2026-11-12T09:00:00.000Z'),
};
const CANCELLED: Partial<NewOrder> = {
  status: 'cancelled',
  cancelledAt: new Date('2026-11-11T20:00:00.000Z'),
};

/** Destructures exactly `count` seeded orders; fails the test otherwise. */
function take<T>(items: T[], count: number): T[] {
  expect(items).toHaveLength(count);
  return items;
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

/** Everything a refused request must leave as it was: orders, rounds, and messages sent. */
async function storedState(): Promise<{ orders: Order[]; rounds: Round[]; sent: number }> {
  return { orders: await orders.list(), rounds: await rounds.list(), sent: sender.sent.length };
}

/** "סגור סבב"; `body` left out sends no body at all. */
function close(roundId: string, body?: object): request.Test {
  const req = request(app)
    .post(`${BASE}/${roundId}/close`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
  return body === undefined ? req : req.send(body);
}

function getRounds(): request.Test {
  return request(app).get(BASE).set('Cookie', cookie);
}

function getRound(id: string): request.Test {
  return request(app).get(`${BASE}/${id}`).set('Cookie', cookie);
}

/** A logged-in POST to a sub-path of the round, as the collector app sends it. */
function postToRound(roundId: string, path: string, body?: object): request.Test {
  const req = request(app)
    .post(`${BASE}/${roundId}/${path}`)
    .set(SAME_ORIGIN_HEADERS)
    .set('Cookie', cookie);
  return body === undefined ? req : req.send(body);
}

/** The customer's "כן, אוציא את הבקבוקים" on their own page (no login). */
function customerConfirm(token: string): request.Test {
  return request(app).post(`/api/o/${token}/confirm`).set(SAME_ORIGIN_HEADERS);
}

/** The round's view in a 200 body, checked against the shared contract the web app parses. */
function viewOf(res: request.Response): RoundView {
  return roundViewSchema.parse(res.body);
}

/** The ids of the orders in each group of a view, in screen order. */
function groupsOf(view: RoundView): Record<string, string[]> {
  return Object.fromEntries(
    view.groups.map((group) => [group.key, group.orders.map((order) => order.id)]),
  );
}

/** Expects `date` to be inside [before, after]: a time the route took from the real clock. */
function expectBetween(date: Date | undefined, before: Date, after: Date): void {
  expect(date).toBeInstanceOf(Date);
  expect(date?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(date?.getTime()).toBeLessThanOrEqual(after.getTime());
}

/** Expects `order` (as stored now) to have left `round` at its close for `reason`. */
function expectSentBack(
  order: Order,
  round: Round,
  reason: 'notReached' | 'notConfirmed',
  before: Date,
  after: Date,
): void {
  expect(order.status).toBe('waiting');
  expect(order).not.toHaveProperty('roundId');
  expect(order.lastMiss).toStrictEqual({ date: round.date, reason, roundId: round.id });
  expectBetween(order.updatedAt, before, after);
}

function expectRouteNotOpen(res: request.Response): void {
  expect(res.status).toBe(409);
  expect(res.body).toStrictEqual({ error: 'route_not_open', message: ROUND_MESSAGES.routeNotOpen });
}

function expectRoundNotFound(res: request.Response): void {
  expect(res.status).toBe(404);
  expect(res.body).toStrictEqual({ error: 'round_not_found' });
}

describe('POST /api/collector/rounds/:id/close: "סגור סבב"', () => {
  it('closes a routed round, sends its stops to collect back as notReached and answers the view', async () => {
    const { round, orders: seeded } = await seedRound(
      [{}, {}, COLLECTED, notFoundIn, CANCELLED, askedOtherDateIn],
      { routed: true },
    );
    const [first, second, collected, notFound, cancelled, otherDate] = take(seeded, 6);
    if (!first || !second || !collected || !notFound || !cancelled || !otherDate) {
      throw new Error();
    }

    const before = new Date();
    const res = await close(round.id);
    const after = new Date();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    // The two stops Yoel did not get to wait for the next round, with "לא הגענו אליו".
    expectSentBack(await storedOrder(first.id), round, 'notReached', before, after);
    expectSentBack(await storedOrder(second.id), round, 'notReached', before, after);
    // Every handled stop, and the order that left earlier, is exactly as it was.
    for (const untouched of [collected, notFound, cancelled, otherDate]) {
      expect(await storedOrder(untouched.id)).toStrictEqual(untouched);
    }
    // The round is closed, keeps its phase, its stops and its orders.
    const stored = await storedRound(round.id);
    expect(stored).toStrictEqual({ ...round, status: 'closed', closedAt: stored.closedAt });
    expectBetween(stored.closedAt, before, after);
    // No message on close.
    expect(sender.sent).toHaveLength(0);

    const view = viewOf(res);
    expect(view.round).toMatchObject({ id: round.id, status: 'closed', phase: 'routed' });
    expect(view.round.closedAt?.getTime()).toBe(stored.closedAt?.getTime());
    expect(view.stops.map((stop) => [stop.order.id, stop.state])).toStrictEqual([
      [first.id, 'left'],
      [second.id, 'left'],
      [collected.id, 'collected'],
      [notFound.id, 'notFound'],
      [cancelled.id, 'cancelled'],
      [otherDate.id, 'left'],
    ]);
    expect(groupsOf(view)).toStrictEqual({
      confirmed: [collected.id],
      pending: [],
      otherDate: [otherDate.id],
    });
    expect(view.sendList).toStrictEqual([]);
    // GET /:id answers the same: the close is stored, not only answered.
    expect((await getRound(round.id)).body).toStrictEqual(res.body);
  });

  it('sends every pending and confirmed order of a confirming round back as notConfirmed', async () => {
    const { round, orders: seeded } = await seedRound([
      { status: 'pending' },
      {},
      askedOtherDateIn,
      CANCELLED,
    ]);
    const [pending, confirmed, otherDate, cancelled] = take(seeded, 4);
    if (!pending || !confirmed || !otherDate || !cancelled) throw new Error();

    const before = new Date();
    const res = await close(round.id);
    const after = new Date();

    expect(res.status).toBe(200);
    expectSentBack(await storedOrder(pending.id), round, 'notConfirmed', before, after);
    expectSentBack(await storedOrder(confirmed.id), round, 'notConfirmed', before, after);
    expect(await storedOrder(otherDate.id)).toStrictEqual(otherDate);
    expect(await storedOrder(cancelled.id)).toStrictEqual(cancelled);

    const stored = await storedRound(round.id);
    expect(stored).toMatchObject({ status: 'closed', phase: 'confirming', stops: [] });
    expectBetween(stored.closedAt, before, after);
    expect(sender.sent).toHaveLength(0);

    const view = viewOf(res);
    expect(view.round).toMatchObject({ status: 'closed', phase: 'confirming' });
    expect(groupsOf(view)).toStrictEqual({ confirmed: [], pending: [], otherDate: [otherDate.id] });
    expect(view.sendList).toStrictEqual([]);
    expect(view.stops).toStrictEqual([]);
  });

  it('sends a stray pending stop of a routed round back as notConfirmed', async () => {
    const { round, orders: seeded } = await seedRound([{ status: 'pending' }, {}], {
      routed: true,
    });
    const [pending, confirmed] = take(seeded, 2);
    if (!pending || !confirmed) throw new Error();

    const before = new Date();
    expect((await close(round.id)).status).toBe(200);
    const after = new Date();

    expectSentBack(await storedOrder(pending.id), round, 'notConfirmed', before, after);
    expectSentBack(await storedOrder(confirmed.id), round, 'notReached', before, after);
  });

  it('closes a routed round with no stops', async () => {
    const { round } = await seedRound([], { routed: true });

    const res = await close(round.id);

    expect(res.status).toBe(200);
    expect(viewOf(res).round).toMatchObject({ status: 'closed', phase: 'routed' });
    expect(viewOf(res).stops).toStrictEqual([]);
  });

  it('ignores any body sent', async () => {
    const { round, orders: seeded } = await seedRound([{}]);
    const [order] = take(seeded, 1);
    if (!order) throw new Error();

    const res = await close(round.id, { status: 'open', reason: 'notFound' });

    expect(res.status).toBe(200);
    expect(viewOf(res).round.status).toBe('closed');
    expect((await storedOrder(order.id)).lastMiss?.reason).toBe('notConfirmed');
  });

  it('answers a second close with 200 and changes nothing more', async () => {
    const { round } = await seedRound([{}, COLLECTED], { routed: true });
    const first = await close(round.id);
    expect(first.status).toBe(200);
    const afterFirst = await storedState();

    const second = await close(round.id);

    expect(second.status).toBe(200);
    // The first closedAt stands, and no order is written again.
    expect(await storedState()).toStrictEqual(afterFirst);
    expect(second.body).toStrictEqual(first.body);
  });

  it('sweeps, on a second close, an order a first close left in the round', async () => {
    // A round closed by a first close whose sweep stopped half way: one stop still confirmed in
    // it, one pending.
    const { round, orders: seeded } = await seedRound([{}, { status: 'pending' }, COLLECTED], {
      routed: true,
      round: { status: 'closed', closedAt: new Date(EARLIER_CLOSE) },
    });
    const [confirmed, pending, collected] = take(seeded, 3);
    if (!confirmed || !pending || !collected) throw new Error();

    const before = new Date();
    const res = await close(round.id);
    const after = new Date();

    expect(res.status).toBe(200);
    expectSentBack(await storedOrder(confirmed.id), round, 'notReached', before, after);
    expectSentBack(await storedOrder(pending.id), round, 'notConfirmed', before, after);
    expect(await storedOrder(collected.id)).toStrictEqual(collected);
    // The round itself is not written again: it keeps its first closedAt.
    expect(await storedRound(round.id)).toStrictEqual(round);
    expect(viewOf(res).round.closedAt?.getTime()).toBe(EARLIER_CLOSE.getTime());
  });

  it.each([
    { label: 'an unknown id', id: UNKNOWN_ID },
    { label: 'a malformed id', id: MALFORMED_ID },
  ])('answers $label with 404 round_not_found, changing nothing', async ({ id }) => {
    await seedRound([{}]);
    const before = await storedState();

    const res = await close(id);

    expectRoundNotFound(res);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await storedState()).toStrictEqual(before);
  });

  it('answers without a session cookie with 401, changing nothing', async () => {
    const { round } = await seedRound([{}]);
    const before = await storedState();

    // From the site itself, so it is the login guard answering, not the Origin check.
    const res = await request(app).post(`${BASE}/${round.id}/close`).set(SAME_ORIGIN_HEADERS);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
    expect(await storedState()).toStrictEqual(before);
  });
});

describe('after "סגור סבב"', () => {
  it('the round leaves GET / (the "סבבים" tab), and GET /:id still answers it', async () => {
    const { round: closing } = await seedRound([{}], { routed: true });
    const { round: other } = await seedRound([{}], { round: { date: '2026-11-15' } });
    expect((await close(closing.id)).status).toBe(200);

    const list = await getRounds();

    expect(list.status).toBe(200);
    expect(
      (list.body as { rounds: RoundView[] }).rounds.map((view) => view.round.id),
    ).toStrictEqual([other.id]);
    const one = await getRound(closing.id);
    expect(one.status).toBe(200);
    expect(viewOf(one).round).toMatchObject({ id: closing.id, status: 'closed' });
  });

  it('refuses the stop actions and moves with 409 route_not_open, changing nothing', async () => {
    const { round, orders: seeded } = await seedRound([{}, {}, COLLECTED], { routed: true });
    const [swept, , collected] = take(seeded, 3);
    if (!swept || !collected) throw new Error();
    expect((await close(round.id)).status).toBe(200);
    const before = await storedState();

    for (const stop of [swept, collected]) {
      expectRouteNotOpen(await postToRound(round.id, `stops/${stop.id}/collected`, {}));
      expectRouteNotOpen(await postToRound(round.id, `stops/${stop.id}/not-found`));
      expectRouteNotOpen(
        await postToRound(round.id, `stops/${stop.id}/move`, { direction: 'down' }),
      );
    }
    expect(await storedState()).toStrictEqual(before);
  });

  it('refuses "אישר בטלפון": 409 confirmations_closed in the round, 404 for an order sent back', async () => {
    const { round, orders: seeded } = await seedRound([{ status: 'pending' }, CANCELLED]);
    const [swept, cancelled] = take(seeded, 2);
    if (!swept || !cancelled) throw new Error();
    expect((await close(round.id)).status).toBe(200);
    const before = await storedState();

    // Still in the round (it keeps its roundId): the closed round answers first.
    const inRound = await postToRound(round.id, `orders/${cancelled.id}/confirm-by-phone`);
    expect(inRound.status).toBe(409);
    expect(inRound.body).toStrictEqual({
      error: 'confirmations_closed',
      message: ROUND_MESSAGES.confirmationsClosed,
    });
    // Sent back: it is in no round any more, so it is not this round's to confirm.
    const left = await postToRound(round.id, `orders/${swept.id}/confirm-by-phone`);
    expect(left.status).toBe(404);
    expect(left.body).toStrictEqual({ error: 'order_not_found' });
    expect(await storedState()).toStrictEqual(before);
  });

  it("refuses the customer's confirm on an order sent back with 409 confirmations_closed", async () => {
    const { round, orders: seeded } = await seedRound([{ status: 'pending' }]);
    const [order] = take(seeded, 1);
    if (!order) throw new Error();
    expect((await close(round.id)).status).toBe(200);
    const before = await storedState();

    const res = await customerConfirm(order.token);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual({
      error: 'confirmations_closed',
      message: CUSTOMER_ORDER_MESSAGES.confirmationsClosed,
    });
    expect(await storedState()).toStrictEqual(before);
  });

  it("refuses the customer's confirm on an order still pending in a closed round", async () => {
    // A first close that stopped before it reached this order: the closed round answers.
    const { orders: seeded } = await seedRound([{ status: 'pending' }], {
      round: { status: 'closed', closedAt: new Date(EARLIER_CLOSE) },
    });
    const [order] = take(seeded, 1);
    if (!order) throw new Error();

    const res = await customerConfirm(order.token);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'confirmations_closed' });
    expect(await storedOrder(order.id)).toStrictEqual(order);
  });
});

describe('"סגור סבב" racing other screens', () => {
  it('leaves a stop collected between the round read and the sweep as it was collected', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, orders: seeded } = await seedRound([{}, {}], { routed: true });
    const [collectedMeanwhile, other] = take(seeded, 2);
    if (!collectedMeanwhile || !other) throw new Error();
    racing.collectBeforeConditionalWrite.add(collectedMeanwhile.id);

    const before = new Date();
    const res = await close(round.id);
    const after = new Date();

    expect(res.status).toBe(200);
    // "אספתי" won: the order stays collected in the round just closed, with its count.
    expect(await storedOrder(collectedMeanwhile.id)).toMatchObject({
      status: 'collected',
      bottlesCollected: 33,
      roundId: round.id,
    });
    expect(await storedOrder(collectedMeanwhile.id)).not.toHaveProperty('lastMiss');
    expectSentBack(await storedOrder(other.id), round, 'notReached', before, after);
    const states = viewOf(res).stops.map((stop) => stop.state);
    expect(states).toStrictEqual(['collected', 'left']);
  });

  it('sends back an order the customer confirmed between the read and the write', async () => {
    const racing = new RacingOrdersRepo();
    buildApp({ orders: racing });
    const { round, orders: seeded } = await seedRound([{ status: 'pending' }]);
    const [order] = take(seeded, 1);
    if (!order) throw new Error();
    racing.confirmOnceBeforeConditionalWrite.add(order.id);

    const before = new Date();
    expect((await close(round.id)).status).toBe(200);
    const after = new Date();

    // The first write missed (pending → confirmed meanwhile); the retry sent the confirmed one back.
    expectSentBack(await storedOrder(order.id), round, 'notConfirmed', before, after);
  });

  it('closes a round routed between the read and the write as routed, with notReached', async () => {
    const racingRounds = new RacingRoundsRepo();
    buildApp({ rounds: racingRounds });
    const { round, orders: seeded } = await seedRound([{}]);
    const [order] = take(seeded, 1);
    if (!order) throw new Error();
    racingRounds.routeOnceBeforeConditionalWrite.set(round.id, {
      phase: 'routed',
      stops: [{ orderId: order.id, hasLocation: true }],
    });

    const before = new Date();
    const res = await close(round.id);
    const after = new Date();

    expect(res.status).toBe(200);
    const stored = await storedRound(round.id);
    expect(stored).toMatchObject({ status: 'closed', phase: 'routed' });
    expectBetween(stored.closedAt, before, after);
    expectSentBack(await storedOrder(order.id), round, 'notReached', before, after);
  });

  it('answers 500 and sweeps nothing when the round keeps changing under the close', async () => {
    const racingRounds = new RacingRoundsRepo();
    buildApp({ rounds: racingRounds });
    const { round } = await seedRound([{}, { status: 'pending' }]);
    racingRounds.alwaysMissConditionalWrites = true;
    const before = await storedState();

    const res = await close(round.id);

    expect(res.status).toBe(500);
    // The round was never closed, so no order may have left it.
    expect(await storedState()).toStrictEqual(before);
  });
});
