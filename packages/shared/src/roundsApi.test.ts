import { describe, expect, it } from 'vitest';
import { MAX_BOTTLES, type MessageLogEntry, type Order } from './order.ts';
import { formFieldErrors } from './orderApi.ts';
import { MAX_ROUND_ORDERS, type Round } from './round.ts';
import {
  COLLECT_STOP_ERRORS,
  PERSONAL_TEXT_MAX_LENGTH,
  ROUND_GROUP_KEYS,
  ROUND_GROUP_LABELS,
  ROUND_PLAN_ERRORS,
  ROUND_STOP_STATES,
  buildRoundView,
  collectStopRequestSchema,
  moveStopRequestSchema,
  planRoundRequestSchema,
  roundStopStateOf,
  roundViewSchema,
  roundsResponseSchema,
  type PlanRoundRequest,
  type RoundGroupKey,
  type RoundView,
} from './roundsApi.ts';

const ERR = ROUND_PLAN_ERRORS;
/** 43 base64url characters, the shape of a real token. */
const TOKEN = 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';
const CREATED_AT = new Date('2026-11-04T17:00:00.000Z');
const OPENED_AT = new Date('2026-11-04T17:05:00.000Z');
const ROUND_ID = 'round-2';

/** `n` distinct order ids. */
function orderIds(n: number): string[] {
  return Array.from({ length: n }, (_, index) => `order-${index + 1}`);
}

/** A valid planning request, as the planning screen sends it. */
function makeRequest(overrides: Partial<PlanRoundRequest> = {}): PlanRoundRequest {
  return {
    date: '2026-11-05',
    region: 'ramat',
    orderIds: ['order-a', 'order-b'],
    personalText: 'השבוע נגיע מוקדם.',
    pickupBy: '08:00',
    ...overrides,
  };
}

/** The `{ field: message }` of a request that must fail, or a failed test if it parses. */
function errorsOf(body: unknown): Record<string, string> {
  const result = planRoundRequestSchema.safeParse(body);
  if (result.success) throw new Error('expected the request to fail');
  return formFieldErrors(result.error);
}

/** The confirmation request of an order as a wa.me link, as `sendAndLog` logs it. */
function confirmLink(orderId: string, openedAt?: Date): MessageLogEntry {
  return {
    kind: 'confirmRequest',
    at: CREATED_AT,
    mode: 'manual',
    url: `https://wa.me/972501234567?text=${orderId}`,
    ...(openedAt === undefined ? {} : { openedAt }),
  };
}

/** A thank-you of an order as a wa.me link, as `sendAndLog` logs it on "אספתי". */
function thankYouLink(orderId: string, openedAt?: Date): MessageLogEntry {
  return {
    kind: 'thankYou',
    at: OPENED_AT,
    mode: 'manual',
    url: `https://wa.me/972501234567?text=thanks-${orderId}`,
    ...(openedAt === undefined ? {} : { openedAt }),
  };
}

/** A stored order on a free-text street, pending in round {@link ROUND_ID} with its request. */
function makeOrder(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    contact: { name: `לקוח ${id}`, phone: '+972501234567', method: 'whatsapp' },
    address: { streetName: 'רחוב חדש', houseNumber: '5', bottlesSpot: 'privateHouse' },
    bottlesEstimated: 45,
    status: 'pending',
    region: 'ramat',
    token: TOKEN,
    roundId: ROUND_ID,
    messages: [confirmLink(id)],
    source: 'form',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** A stored open round in its confirmation step, with the given orders. */
function makeRound(ids: string[], overrides: Partial<Round> = {}): Round {
  return {
    id: ROUND_ID,
    date: '2026-11-05',
    region: 'ramat',
    status: 'open',
    phase: 'confirming',
    pickupBy: '08:00',
    orderIds: ids,
    stops: [],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** The ids in one group of a view. */
function idsIn(view: RoundView, key: RoundGroupKey): string[] {
  const group = view.groups.find((candidate) => candidate.key === key);
  if (group === undefined) throw new Error(`no group ${key}`);
  return group.orders.map((order) => order.id);
}

describe('planRoundRequestSchema', () => {
  it('accepts a plan and trims the personal text, keeping its inner line breaks', () => {
    expect(
      planRoundRequestSchema.parse(makeRequest({ personalText: '  שורה אחת\nשורה שתיים \n' })),
    ).toEqual({
      date: '2026-11-05',
      region: 'ramat',
      orderIds: ['order-a', 'order-b'],
      personalText: 'שורה אחת\nשורה שתיים',
      pickupBy: '08:00',
    });
  });

  it('accepts a plan without personalText and pickupBy', () => {
    const plan = { date: '2026-11-05', region: 'old', orderIds: ['order-a'] };
    expect(planRoundRequestSchema.parse(plan)).toEqual(plan);
  });

  // A form sends '' for a field left empty: the round must not store a blank text or time.
  it('drops a blank personalText and an empty pickupBy', () => {
    const plan = planRoundRequestSchema.parse(makeRequest({ personalText: '  \n ', pickupBy: '' }));
    expect(plan.personalText).toBeUndefined();
    expect(plan.pickupBy).toBeUndefined();
    expect(JSON.parse(JSON.stringify(plan))).toEqual({
      date: '2026-11-05',
      region: 'ramat',
      orderIds: ['order-a', 'order-b'],
    });
  });

  it('asks for at least one order', () => {
    expect(errorsOf(makeRequest({ orderIds: [] }))).toEqual({ orderIds: ERR.noOrders });
    expect(errorsOf({ date: '2026-11-05', region: 'ramat' })).toEqual({ orderIds: ERR.noOrders });
  });

  it(`accepts ${MAX_ROUND_ORDERS} orders and refuses one more (spec §1)`, () => {
    expect(planRoundRequestSchema.safeParse(makeRequest({ orderIds: orderIds(25) })).success).toBe(
      true,
    );
    expect(errorsOf(makeRequest({ orderIds: orderIds(26) }))).toEqual({
      orderIds: ERR.tooManyOrders,
    });
    expect(ERR.tooManyOrders).toContain('25');
  });

  it('refuses the same order marked twice', () => {
    expect(errorsOf(makeRequest({ orderIds: ['order-a', 'order-b', 'order-a'] }))).toEqual({
      orderIds: ERR.duplicateOrders,
    });
  });

  it('refuses a pickupBy that is not HH:MM, in Hebrew', () => {
    for (const pickupBy of ['8:00', '24:00', '08:60', 'בבוקר', '08:00:00']) {
      expect(errorsOf(makeRequest({ pickupBy })), pickupBy).toEqual({
        pickupBy: ERR.pickupByInvalid,
      });
    }
    expect(errorsOf({ ...makeRequest(), pickupBy: 800 })).toEqual({
      pickupBy: ERR.pickupByInvalid,
    });
  });

  it(`refuses a personal text over ${PERSONAL_TEXT_MAX_LENGTH} characters after trimming`, () => {
    const longest = 'א'.repeat(PERSONAL_TEXT_MAX_LENGTH);
    expect(
      planRoundRequestSchema.parse(makeRequest({ personalText: ` ${longest} ` })),
    ).toMatchObject({ personalText: longest });
    expect(errorsOf(makeRequest({ personalText: `${longest}א` }))).toEqual({
      personalText: ERR.personalTextTooLong,
    });
  });

  it('asks for a real date and a region, in Hebrew', () => {
    for (const date of ['', '05/11/2026', '2026-02-30', undefined]) {
      expect(errorsOf({ ...makeRequest(), date }), String(date)).toEqual({
        date: ERR.dateRequired,
      });
    }
    for (const region of ['', 'jerusalem', undefined]) {
      expect(errorsOf({ ...makeRequest(), region }), String(region)).toEqual({
        region: ERR.regionRequired,
      });
    }
  });

  it('shows every mistake at once', () => {
    expect(errorsOf({ date: '', region: '', orderIds: [] })).toEqual({
      date: ERR.dateRequired,
      region: ERR.regionRequired,
      orderIds: ERR.noOrders,
    });
  });

  // Strict: the status, phase and the like are the api's to set, never the client's.
  it('refuses an unknown key', () => {
    expect(planRoundRequestSchema.safeParse({ ...makeRequest(), status: 'closed' }).success).toBe(
      false,
    );
  });
});

describe('ROUND_GROUP_LABELS', () => {
  it('has a Hebrew title for every group, in screen order', () => {
    expect(ROUND_GROUP_KEYS).toEqual(['confirmed', 'pending', 'otherDate']);
    expect(Object.keys(ROUND_GROUP_LABELS)).toEqual([...ROUND_GROUP_KEYS]);
  });
});

describe('buildRoundView', () => {
  it('puts each order of the round in its group, in plan order', () => {
    const round = makeRound(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    // Given in another order than the plan's: the view follows `round.orderIds`.
    const orders = [
      makeOrder('h', { status: 'confirmed' }),
      makeOrder('g', {
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: '2026-11-05', reason: 'notConfirmed', roundId: ROUND_ID },
      }),
      makeOrder('f'),
      makeOrder('e', { status: 'collected' }),
      makeOrder('d', {
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: '2026-11-05', reason: 'askedOtherDate', roundId: ROUND_ID },
      }),
      makeOrder('c', { status: 'confirmed' }),
      makeOrder('b'),
      makeOrder('a', { status: 'confirmed' }),
    ];
    const view = buildRoundView(round, orders);
    expect(view.groups.map((group) => group.key)).toEqual([...ROUND_GROUP_KEYS]);
    expect(idsIn(view, 'confirmed')).toEqual(['a', 'c', 'e', 'h']);
    expect(idsIn(view, 'pending')).toEqual(['b', 'f']);
    // Only who asked for another date: 'g' left because it did not confirm, so it is in none.
    expect(idsIn(view, 'otherDate')).toEqual(['d']);
    expect(view.groups.flatMap((group) => group.orders.map((order) => order.id))).not.toContain(
      'g',
    );
  });

  it('puts an order that left the round for another reason in no group', () => {
    const round = makeRound(['a', 'b', 'c']);
    const leftFor = (id: string, reason: 'addressChanged' | 'notFound' | 'notReached'): Order =>
      makeOrder(id, {
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: '2026-11-05', reason, roundId: ROUND_ID },
      });
    const view = buildRoundView(round, [
      leftFor('a', 'addressChanged'),
      leftFor('b', 'notFound'),
      leftFor('c', 'notReached'),
    ]);
    expect(view.groups.flatMap((group) => group.orders)).toEqual([]);
  });

  it('finds an order that left the round by lastMiss, even once it is in another round', () => {
    const round = makeRound(['a']);
    const plannedAgain = makeOrder('a', {
      roundId: 'round-3',
      lastMiss: { date: '2026-11-05', reason: 'askedOtherDate', roundId: ROUND_ID },
    });
    expect(idsIn(buildRoundView(round, [plannedAgain]), 'otherDate')).toEqual(['a']);
  });

  it('leaves out an order cancelled in the round, and one that missed another round', () => {
    const round = makeRound(['a', 'b']);
    const view = buildRoundView(round, [
      makeOrder('a', { status: 'cancelled' }),
      makeOrder('b', {
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: '2026-10-29', reason: 'notConfirmed', roundId: 'round-1' },
      }),
    ]);
    expect(view.groups.flatMap((group) => group.orders)).toEqual([]);
  });

  it('ignores an order given that is not in orderIds, and an id with no order given', () => {
    const view = buildRoundView(makeRound(['a', 'missing']), [makeOrder('a'), makeOrder('z')]);
    expect(idsIn(view, 'pending')).toEqual(['a']);
    expect(view.sendList.map((link) => link.orderId)).toEqual(['a']);
  });

  it('builds the send list from the pending orders only, in plan order', () => {
    const round = makeRound(['a', 'b', 'c']);
    const view = buildRoundView(round, [
      makeOrder('a'),
      makeOrder('b', { status: 'confirmed' }),
      makeOrder('c', { messages: [confirmLink('c', OPENED_AT)] }),
    ]);
    expect(view.sendList).toEqual([
      {
        orderId: 'a',
        messageIndex: 0,
        kind: 'confirmRequest',
        name: 'לקוח a',
        url: 'https://wa.me/972501234567?text=a',
      },
      {
        orderId: 'c',
        messageIndex: 0,
        kind: 'confirmRequest',
        name: 'לקוח c',
        url: 'https://wa.me/972501234567?text=c',
        openedAt: OPENED_AT,
      },
    ]);
  });

  // An older wa.me link is an earlier round's, with its date: never offered to send again.
  it('gives no send row to a pending order whose newest request is not a manual link', () => {
    const round = makeRound(['a', 'b']);
    const view = buildRoundView(round, [
      makeOrder('a', {
        messages: [
          confirmLink('a'),
          { kind: 'confirmRequest', at: CREATED_AT, mode: 'failed', reason: 'timeout' },
        ],
      }),
      makeOrder('b', { messages: [] }),
    ]);
    expect(idsIn(view, 'pending')).toEqual(['a', 'b']);
    expect(view.sendList).toEqual([]);
  });

  it('returns the round without orderIds and stops', () => {
    // With the Mongo document's own key too, in case a repo passes it through.
    const stored = {
      ...makeRound(['a'], { personalText: 'תודה!', stops: [{ orderId: 'a', hasLocation: true }] }),
      _id: 'mongo',
    };
    expect(buildRoundView(stored, [makeOrder('a')]).round).toEqual({
      id: ROUND_ID,
      date: '2026-11-05',
      region: 'ramat',
      status: 'open',
      phase: 'confirming',
      personalText: 'תודה!',
      pickupBy: '08:00',
      createdAt: CREATED_AT,
    });
  });

  it('returns all three groups, empty ones too, for a round with no orders found', () => {
    const view = buildRoundView(makeRound(['a']), []);
    expect(view.groups).toEqual(ROUND_GROUP_KEYS.map((key) => ({ key, orders: [] })));
    expect(view.sendList).toEqual([]);
  });

  it('gives each order as the collector screens get it, without token or messages', () => {
    const [order] = buildRoundView(makeRound(['a']), [makeOrder('a')]).groups[1]?.orders ?? [];
    expect(order).toMatchObject({ id: 'a', status: 'pending', hasLocation: false });
    expect(order).not.toHaveProperty('token');
    expect(order).not.toHaveProperty('messages');
  });

  it('returns no stops for a round still confirming', () => {
    expect(buildRoundView(makeRound(['a']), [makeOrder('a')]).stops).toEqual([]);
  });

  it('returns a routed round’s stops in stored order, with stored hasLocation and state', () => {
    // Plan order a, b, c, d; the route drives c, missing, a, d. 'b' left before the route.
    const round = makeRound(['a', 'b', 'c', 'd', 'missing'], {
      phase: 'routed',
      stops: [
        { orderId: 'c', hasLocation: true },
        { orderId: 'missing', hasLocation: true },
        { orderId: 'a', hasLocation: true },
        { orderId: 'd', hasLocation: false },
      ],
    });
    const view = buildRoundView(round, [
      makeOrder('a', { status: 'collected' }),
      makeOrder('b', {
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: '2026-11-05', reason: 'notConfirmed', roundId: ROUND_ID },
      }),
      makeOrder('c', { status: 'confirmed' }),
      makeOrder('d', {
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: '2026-11-05', reason: 'notFound', roundId: ROUND_ID },
      }),
    ]);
    expect(
      view.stops.map((stop) => ({
        id: stop.order.id,
        hasLocation: stop.hasLocation,
        state: stop.state,
      })),
    ).toEqual([
      // Free-text street, so the order has no point today: the stop keeps what was stored.
      { id: 'c', hasLocation: true, state: 'toCollect' },
      { id: 'a', hasLocation: true, state: 'collected' },
      { id: 'd', hasLocation: false, state: 'notFound' },
    ]);
    expect(view.stops[0]?.order).toMatchObject({ id: 'c', hasLocation: false });
    expect(view.stops[0]?.order).not.toHaveProperty('token');
  });

  describe('thankYou of a stop', () => {
    /** A routed round whose route is the given orders, in that order. */
    const routedRound = (ids: string[]): Round =>
      makeRound(ids, {
        phase: 'routed',
        stops: ids.map((orderId) => ({ orderId, hasLocation: true })),
      });

    it('gives a collected stop its newest thankYou wa.me link', () => {
      const view = buildRoundView(routedRound(['a', 'b']), [
        makeOrder('a', {
          status: 'collected',
          messages: [confirmLink('a', OPENED_AT), thankYouLink('a')],
        }),
        // An older thank-you behind the newest one: the newest counts.
        makeOrder('b', {
          status: 'collected',
          messages: [confirmLink('b'), thankYouLink('old'), thankYouLink('b', OPENED_AT)],
        }),
      ]);
      expect(view.stops.map((stop) => stop.thankYou)).toEqual([
        {
          orderId: 'a',
          messageIndex: 1,
          kind: 'thankYou',
          name: 'לקוח a',
          url: 'https://wa.me/972501234567?text=thanks-a',
        },
        {
          orderId: 'b',
          messageIndex: 2,
          kind: 'thankYou',
          name: 'לקוח b',
          url: 'https://wa.me/972501234567?text=thanks-b',
          openedAt: OPENED_AT,
        },
      ]);
    });

    it('leaves the key out for a collected stop whose newest thankYou failed or is missing', () => {
      const view = buildRoundView(routedRound(['a', 'b']), [
        makeOrder('a', {
          status: 'collected',
          messages: [
            thankYouLink('a'),
            { kind: 'thankYou', at: OPENED_AT, mode: 'failed', reason: 'timeout' },
          ],
        }),
        makeOrder('b', { status: 'collected' }),
      ]);
      expect(view.stops.map((stop) => stop.state)).toEqual(['collected', 'collected']);
      for (const stop of view.stops) expect(stop).not.toHaveProperty('thankYou');
    });

    // A thank-you from an earlier round must not offer "שלח תודה" at a stop not collected here.
    it('never gives one to a stop that is not collected, even with an older thankYou', () => {
      const messages = [thankYouLink('earlier'), confirmLink('x')];
      const view = buildRoundView(routedRound(['a', 'b', 'c']), [
        makeOrder('a', { status: 'confirmed', messages }),
        makeOrder('b', {
          status: 'waiting',
          roundId: undefined,
          lastMiss: { date: '2026-11-05', reason: 'notFound', roundId: ROUND_ID },
          messages,
        }),
        makeOrder('c', { status: 'cancelled', messages }),
      ]);
      expect(view.stops.map((stop) => stop.state)).toEqual(['toCollect', 'notFound', 'cancelled']);
      for (const stop of view.stops) expect(stop).not.toHaveProperty('thankYou');
    });

    it('survives the JSON round trip, with openedAt as a Date', () => {
      const view = buildRoundView(routedRound(['a']), [
        makeOrder('a', { status: 'collected', messages: [thankYouLink('a', OPENED_AT)] }),
      ]);
      const parsed = roundViewSchema.parse(JSON.parse(JSON.stringify(view)));
      expect(parsed).toEqual(view);
      expect(parsed.stops[0]?.thankYou?.openedAt).toBeInstanceOf(Date);
    });
  });
});

describe('roundStopStateOf', () => {
  const round = makeRound(['a'], { phase: 'routed', stops: [{ orderId: 'a', hasLocation: true }] });
  /** The order out of the round, back to waiting, with this round's lastMiss for `reason`. */
  const leftFor = (reason: 'notFound' | 'addressChanged' | 'askedOtherDate'): Order =>
    makeOrder('a', {
      status: 'waiting',
      roundId: undefined,
      lastMiss: { date: '2026-11-05', reason, roundId: ROUND_ID },
    });

  it('lists the states in a stable order', () => {
    expect(ROUND_STOP_STATES).toEqual(['toCollect', 'collected', 'notFound', 'cancelled', 'left']);
  });

  it('is toCollect for a confirmed or pending order still in the round', () => {
    expect(roundStopStateOf(round, makeOrder('a', { status: 'confirmed' }))).toBe('toCollect');
    expect(roundStopStateOf(round, makeOrder('a'))).toBe('toCollect');
  });

  it('is collected or cancelled as the status of an order in the round says', () => {
    expect(roundStopStateOf(round, makeOrder('a', { status: 'collected' }))).toBe('collected');
    expect(roundStopStateOf(round, makeOrder('a', { status: 'cancelled' }))).toBe('cancelled');
  });

  it('is notFound for an order that left this round as not found', () => {
    expect(roundStopStateOf(round, leftFor('notFound'))).toBe('notFound');
  });

  // What happened at THIS stop: a later round's or a later cancel does not rewrite it.
  it('stays notFound once the order is planned, collected or cancelled elsewhere', () => {
    const later = leftFor('notFound');
    expect(roundStopStateOf(round, { ...later, status: 'pending', roundId: 'round-3' })).toBe(
      'notFound',
    );
    expect(roundStopStateOf(round, { ...later, status: 'collected', roundId: 'round-3' })).toBe(
      'notFound',
    );
    expect(roundStopStateOf(round, { ...later, status: 'cancelled' })).toBe('notFound');
  });

  it('is left for an order that left the round another way', () => {
    expect(roundStopStateOf(round, leftFor('addressChanged'))).toBe('left');
    expect(roundStopStateOf(round, leftFor('askedOtherDate'))).toBe('left');
    // Not found, but in another round.
    expect(
      roundStopStateOf(
        round,
        makeOrder('a', {
          status: 'waiting',
          roundId: undefined,
          lastMiss: { date: '2026-10-29', reason: 'notFound', roundId: 'round-1' },
        }),
      ),
    ).toBe('left');
    expect(roundStopStateOf(round, makeOrder('a', { status: 'waiting', roundId: undefined }))).toBe(
      'left',
    );
  });

  // "לא נמצא" stores lastMiss { this round, notFound } and unsets roundId.
  it('is notFound for an order marked not found in this round', () => {
    const notFoundHere = makeOrder('a', {
      status: 'waiting',
      roundId: undefined,
      lastMiss: { date: '2026-11-05', reason: 'notFound', roundId: ROUND_ID },
    });
    expect(roundStopStateOf(round, notFoundHere)).toBe('notFound');
  });

  // The documented limit: one lastMiss only (spec §4). Still a handled state, never toCollect.
  it('turns left once another round overwrites the lastMiss', () => {
    for (const reason of ['notConfirmed', 'askedOtherDate', 'notFound'] as const) {
      const missedLater = makeOrder('a', {
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: '2026-11-12', reason, roundId: 'round-3' },
      });
      expect(roundStopStateOf(round, missedLater), reason).toBe('left');
    }
  });
});

describe('moveStopRequestSchema', () => {
  it('accepts up and down', () => {
    expect(moveStopRequestSchema.parse({ direction: 'up' })).toEqual({ direction: 'up' });
    expect(moveStopRequestSchema.parse({ direction: 'down' })).toEqual({ direction: 'down' });
  });

  it('refuses another direction, a missing one, and an unknown key', () => {
    for (const body of [
      { direction: 'left' },
      { direction: '' },
      { direction: 1 },
      {},
      { direction: 'up', to: 3 },
      null,
    ]) {
      expect(moveStopRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('roundViewSchema and roundsResponseSchema', () => {
  /** A view with a confirmed order, a pending one with an opened link, and a closed round. */
  function makeView(): RoundView {
    return buildRoundView(makeRound(['a', 'b'], { closedAt: OPENED_AT }), [
      makeOrder('a', { status: 'confirmed' }),
      makeOrder('b', { messages: [confirmLink('b', OPENED_AT)] }),
    ]);
  }

  it('parses the JSON of a routed view, stops included', () => {
    const view = buildRoundView(
      makeRound(['a', 'b'], {
        phase: 'routed',
        stops: [
          { orderId: 'b', hasLocation: false },
          { orderId: 'a', hasLocation: true },
        ],
      }),
      [makeOrder('a', { status: 'confirmed' }), makeOrder('b', { status: 'collected' })],
    );
    expect(view.stops).toHaveLength(2);
    const parsed = roundViewSchema.parse(JSON.parse(JSON.stringify(view)));
    expect(parsed).toEqual(view);
    expect(parsed.stops[0]?.order.createdAt).toBeInstanceOf(Date);
  });

  it('refuses a stop with an unknown state', () => {
    const view = buildRoundView(
      makeRound(['a'], { phase: 'routed', stops: [{ orderId: 'a', hasLocation: true }] }),
      [makeOrder('a', { status: 'confirmed' })],
    );
    const json = JSON.parse(JSON.stringify(view)) as { stops: { state: string }[] };
    const broken = { ...json, stops: json.stops.map((stop) => ({ ...stop, state: 'archived' })) };
    expect(roundViewSchema.safeParse(broken).success).toBe(false);
  });

  // What the web gets is JSON: ISO strings that the schemas turn back into Dates.
  it('parses the JSON of a view back into the same view, with Dates', () => {
    const view = makeView();
    const parsed = roundViewSchema.parse(JSON.parse(JSON.stringify(view)));
    expect(parsed).toEqual(view);
    expect(parsed.round.createdAt).toBeInstanceOf(Date);
    expect(parsed.sendList[0]?.openedAt).toEqual(OPENED_AT);
  });

  it('parses the list of open rounds, with and without previousPickupBy', () => {
    const body = { rounds: [makeView()], previousPickupBy: '07:30' };
    expect(roundsResponseSchema.parse(JSON.parse(JSON.stringify(body)))).toEqual(body);
    expect(roundsResponseSchema.parse({ rounds: [] })).toEqual({ rounds: [] });
  });

  it('rejects a previousPickupBy that is not HH:MM', () => {
    expect(roundsResponseSchema.safeParse({ rounds: [], previousPickupBy: '7:30' }).success).toBe(
      false,
    );
  });
});

describe('collectStopRequestSchema', () => {
  /** The `{ field: message }` of a body that must fail, or a failed test if it parses. */
  function collectErrorsOf(body: unknown): Record<string, string> {
    const result = collectStopRequestSchema.safeParse(body);
    if (result.success) throw new Error('expected the body to fail');
    return formFieldErrors(result.error);
  }

  it('accepts an empty body, so the api fills in the estimate', () => {
    expect(collectStopRequestSchema.parse({})).toEqual({});
  });

  // 20 minimum is a booking rule: the real count may be lower than the estimate.
  it('accepts a whole count below the booking minimum, and up to the maximum', () => {
    for (const bottlesCollected of [12, 1, MAX_BOTTLES]) {
      expect(collectStopRequestSchema.parse({ bottlesCollected })).toEqual({ bottlesCollected });
    }
  });

  it('refuses zero, a negative, a fraction and a string, in Hebrew', () => {
    for (const bottlesCollected of [0, -1, -3, 2.5, '40', '', null]) {
      expect(collectErrorsOf({ bottlesCollected }), JSON.stringify(bottlesCollected)).toEqual({
        bottlesCollected: COLLECT_STOP_ERRORS.bottlesInvalid,
      });
    }
  });

  it(`refuses more than ${MAX_BOTTLES} bottles, in Hebrew`, () => {
    expect(collectErrorsOf({ bottlesCollected: MAX_BOTTLES + 1 })).toEqual({
      bottlesCollected: COLLECT_STOP_ERRORS.bottlesTooMany,
    });
    expect(COLLECT_STOP_ERRORS.bottlesTooMany).toContain(String(MAX_BOTTLES));
  });

  // Strict: the status, collectedAt and the like are the api's to set, never the client's.
  it('refuses an unknown key', () => {
    expect(collectStopRequestSchema.safeParse({ bottlesCollected: 40, status: 'x' }).success).toBe(
      false,
    );
    expect(collectStopRequestSchema.safeParse({ bottles: 40 }).success).toBe(false);
  });
});
