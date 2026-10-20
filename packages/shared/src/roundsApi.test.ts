import { describe, expect, it } from 'vitest';
import type { MessageLogEntry, Order } from './order.ts';
import { formFieldErrors } from './orderApi.ts';
import { MAX_ROUND_ORDERS, type Round } from './round.ts';
import {
  PERSONAL_TEXT_MAX_LENGTH,
  ROUND_GROUP_KEYS,
  ROUND_GROUP_LABELS,
  ROUND_PLAN_ERRORS,
  buildRoundView,
  planRoundRequestSchema,
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
      ...makeRound(['a'], { personalText: 'תודה!', stops: [{ orderId: 'a' }] }),
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
});

describe('roundViewSchema and roundsResponseSchema', () => {
  /** A view with a confirmed order, a pending one with an opened link, and a closed round. */
  function makeView(): RoundView {
    return buildRoundView(makeRound(['a', 'b'], { closedAt: OPENED_AT }), [
      makeOrder('a', { status: 'confirmed' }),
      makeOrder('b', { messages: [confirmLink('b', OPENED_AT)] }),
    ]);
  }

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
