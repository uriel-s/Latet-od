import { describe, expect, it } from 'vitest';
import type {
  CollectorOrder,
  PlanRoundRequest,
  RoundView,
  RoundsResponse,
} from '@bottlerun/shared';
import { jsonBodyOf, makeFakeFetch } from './fakeFetch.ts';
import type { FetchFn } from './request.ts';
import { describeEveryEndpoint, type EndpointCase } from './request.contract.ts';
import {
  buildRoute,
  closeRound,
  collectStop,
  fetchRounds,
  markStopNotFound,
  moveStop,
  planRound,
  type StopActionOutcome,
} from './roundsApi.ts';
import { ODD_ID, ODD_ID_IN_PATH, ORDER } from './testFixtures.ts';

/**
 * A planned round with one order in it and its "שלח" row, as the api answers it. JSON.stringify
 * writes the Dates as ISO strings, so a parsed answer equal to this one has turned them back.
 */
const ROUND_VIEW: RoundView = {
  round: {
    id: '6710f3a2c4b5d6e7f8a9b0d2',
    date: '2026-11-12',
    region: 'ramat',
    status: 'open',
    phase: 'confirming',
    personalText: 'תודה רבה!',
    pickupBy: '08:00',
    createdAt: new Date('2026-10-20T07:00:00.000Z'),
  },
  groups: [
    { key: 'inRound', orders: [{ ...ORDER, status: 'confirmed' }] },
    { key: 'otherDate', orders: [] },
  ],
  sendList: [
    {
      orderId: ORDER.id,
      messageIndex: 0,
      kind: 'confirmRequest',
      name: 'משה כהן',
      url: 'https://wa.me/972501234567?text=%D7%A9%D7%9C%D7%95%D7%9D',
    },
  ],
  stops: [],
};

/** Bodies of a success that are not a `RoundView`: each must answer `failed`. */
const NOT_A_ROUND_VIEW: ({ body: unknown } | { text: string })[] = [
  { body: { ...ROUND_VIEW, round: { ...ROUND_VIEW.round, status: 'archived' } } },
  { body: { ...ROUND_VIEW, round: { ...ROUND_VIEW.round, date: '12/11' } } },
  { body: { ...ROUND_VIEW, groups: [{ key: 'maybe', orders: [] }] } },
  {
    body: { ...ROUND_VIEW, sendList: [{ ...ROUND_VIEW.sendList[0], url: 'javascript:alert(1)' }] },
  },
  { body: { round: ROUND_VIEW.round } },
  { body: { view: ROUND_VIEW } },
  { text: '<html>ok</html>' },
];

describe('fetchRounds', () => {
  const ROUNDS: RoundsResponse = { rounds: [ROUND_VIEW], previousPickupBy: '08:30' };

  it('asks GET /api/collector/rounds, past the browser cache', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUNDS });

    await fetchRounds(fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/rounds');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('answers loaded with the rounds and the previous pickup time on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUNDS });

    const outcome = await fetchRounds(fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', rounds: [ROUND_VIEW], previousPickupBy: '08:30' });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.rounds[0]?.round.createdAt).toBeInstanceOf(Date);
    expect(outcome.rounds[0]?.groups[0]?.orders[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('carries previousPickupFrom next to previousPickupBy', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 200,
      body: { ...ROUNDS, previousPickupFrom: '07:00' },
    });

    const outcome = await fetchRounds(fetchFn);

    expect(outcome).toEqual({
      kind: 'loaded',
      rounds: [ROUND_VIEW],
      previousPickupBy: '08:30',
      previousPickupFrom: '07:00',
    });
  });

  it('answers loaded without a pickup time when the api has none, and with no rounds', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: { rounds: [] } });

    const outcome = await fetchRounds(fetchFn);

    expect(outcome).toEqual({ kind: 'loaded', rounds: [] });
    if (outcome.kind !== 'loaded') throw new Error('expected loaded');
    expect(outcome.previousPickupBy).toBeUndefined();
  });

  it('answers failed on a 200 whose body is not the rounds', async () => {
    for (const answer of [
      { status: 200, body: { rounds: [ROUND_VIEW], previousPickupBy: '8:30' } },
      {
        status: 200,
        body: { rounds: [{ ...ROUND_VIEW, round: { ...ROUND_VIEW.round, id: '' } }] },
      },
      { status: 200, body: [ROUND_VIEW] },
      { status: 200, body: {} },
      { status: 200, text: '<html>ok</html>' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await fetchRounds(fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });
});

/** What the planning screen sends: a pickup time, and its personal text as typed. */
const PLAN: PlanRoundRequest = {
  date: '2026-11-12',
  region: 'ramat',
  orderIds: [ORDER.id, '6710f3a2c4b5d6e7f8a9b0c9'],
  pickupBy: '08:00',
  personalText: 'תודה רבה!',
};

describe('planRound', () => {
  it('posts the request as JSON to /api/collector/rounds', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 201, body: ROUND_VIEW });

    await planRound(PLAN, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/collector/rounds');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(jsonBodyOf(calls[0])).toEqual(PLAN);
  });

  it('answers planned with the round view on 201, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 201, body: ROUND_VIEW });

    const outcome = await planRound(PLAN, fetchFn);

    expect(outcome).toEqual({ kind: 'planned', view: ROUND_VIEW });
    if (outcome.kind !== 'planned') throw new Error('expected planned');
    expect(outcome.view.round.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 201 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUND_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 201, ...answer });
      expect(await planRound(PLAN, fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });

  it('answers failed on a 200: only 201 means planned', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUND_VIEW });

    expect(await planRound(PLAN, fetchFn)).toEqual({ kind: 'failed' });
  });

  it('answers invalid with the field errors of a 400 invalid_round', async () => {
    const fieldErrors = { date: 'נא לבחור תאריך', orderIds: 'אפשר לסמן עד 25 הזמנות בסבב' };
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: { error: 'invalid_round', fieldErrors },
    });

    expect(await planRound(PLAN, fetchFn)).toEqual({ kind: 'invalid', fieldErrors });
  });

  it('answers invalid with no field errors on a 400 without usable ones', async () => {
    for (const answer of [
      { status: 400, body: { error: 'invalid_round', fieldErrors: { date: 7 } } },
      { status: 400, body: { error: 'invalid_round', fieldErrors: ['date'] } },
      { status: 400, body: { error: 'invalid_json' } },
      { status: 400, text: 'Bad Request' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await planRound(PLAN, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'invalid',
        fieldErrors: {},
      });
    }
  });

  it('answers ordersNotWaiting with the shared message and the ids on a 409 orders_not_waiting', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'orders_not_waiting', message: 'anything', orderIds: [ORDER.id] },
    });

    expect(await planRound(PLAN, fetchFn)).toEqual({
      kind: 'ordersNotWaiting',
      message: 'חלק מההזמנות כבר לא ממתינות לסבב. נא לרענן את הרשימה ולנסות שוב.',
      orderIds: [ORDER.id],
    });
  });

  it('answers ordersNotWaiting with no ids when the 409 lists none the app can read', async () => {
    for (const orderIds of [undefined, 'o1', [ORDER.id, 7], { 0: ORDER.id }]) {
      const { fetchFn } = makeFakeFetch({
        status: 409,
        body: { error: 'orders_not_waiting', message: 'x', orderIds },
      });
      expect(await planRound(PLAN, fetchFn), JSON.stringify(orderIds)).toEqual({
        kind: 'ordersNotWaiting',
        message: 'חלק מההזמנות כבר לא ממתינות לסבב. נא לרענן את הרשימה ולנסות שוב.',
        orderIds: [],
      });
    }
  });

  it('answers failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'duplicate_open_order', message: 'x' } },
      { status: 409, body: { message: 'x', orderIds: [ORDER.id] } },
      { status: 409, body: ['orders_not_waiting'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await planRound(PLAN, fetchFn), JSON.stringify(answer)).toEqual({ kind: 'failed' });
    }
  });
});

/** A second order of the routed round, still to collect, at a street with no map point. */
const SECOND_ORDER: CollectorOrder = {
  ...ORDER,
  id: '6710f3a2c4b5d6e7f8a9b0c9',
  status: 'confirmed',
  hasLocation: false,
};

/**
 * The round once its route is built and its first stop collected: that stop carries its
 * "שלח תודה" row, the second is still to collect.
 */
const ROUTED_VIEW: RoundView = {
  ...ROUND_VIEW,
  round: { ...ROUND_VIEW.round, phase: 'routed' },
  groups: [
    { key: 'inRound', orders: [{ ...ORDER, status: 'collected' }, SECOND_ORDER] },
    { key: 'otherDate', orders: [] },
  ],
  sendList: [],
  stops: [
    {
      order: { ...ORDER, status: 'collected' },
      hasLocation: true,
      state: 'collected',
      thankYou: {
        orderId: ORDER.id,
        messageIndex: 1,
        kind: 'thankYou',
        name: 'משה כהן',
        url: 'https://wa.me/972501234567?text=%D7%AA%D7%95%D7%93%D7%94',
      },
    },
    { order: SECOND_ORDER, hasLocation: false, state: 'toCollect' },
  ],
};

/** Bodies of a success that are not a routed `RoundView`, on top of {@link NOT_A_ROUND_VIEW}. */
const NOT_A_ROUTED_VIEW: ({ body: unknown } | { text: string })[] = [
  ...NOT_A_ROUND_VIEW,
  { body: { ...ROUTED_VIEW, stops: [{ ...ROUTED_VIEW.stops[0], state: 'maybe' }] } },
  { body: { ...ROUTED_VIEW, stops: undefined } },
];

describe('buildRoute', () => {
  it('posts to /api/collector/rounds/:id/route, the id encoded, no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await buildRoute(ODD_ID, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/rounds/${ODD_ID_IN_PATH}/route`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('answers built with the routed view on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    const outcome = await buildRoute(ROUND_VIEW.round.id, fetchFn);

    expect(outcome).toEqual({ kind: 'built', view: ROUTED_VIEW });
    if (outcome.kind !== 'built') throw new Error('expected built');
    expect(outcome.view.stops[1]?.order.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUTED_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers closed with the shared message on a 409 confirmations_closed', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'confirmations_closed', message: 'anything' },
    });

    expect(await buildRoute(ROUND_VIEW.round.id, fetchFn)).toEqual({
      kind: 'closed',
      message: 'המסלול של הסבב הזה כבר נבנה, או שהסבב נסגר. נא לרענן את המסך.',
    });
  });

  it('answers failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'route_not_open', message: 'x' } },
      { status: 409, body: { error: 'invalid_transition', message: 'x' } },
      { status: 409, body: { message: 'x' } },
      { status: 409, body: ['confirmations_closed'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers notFound on a 404', async () => {
    for (const answer of [
      { status: 404, body: { error: 'round_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await buildRoute(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'notFound',
      });
    }
  });
});

/** One stop action, called the way the route screen calls it. */
interface StopActionCase {
  name: string;
  act: (roundId: string, orderId: string, fetchFn: FetchFn) => Promise<StopActionOutcome>;
  /** The path's last segment, after `/stops/:orderId/`. */
  action: string;
  /** The JSON body it sends, or undefined for none. */
  body: unknown;
}

const STOP_ACTIONS: StopActionCase[] = [
  {
    name: 'moveStop',
    act: (roundId, orderId, fetchFn) => moveStop(roundId, orderId, 'down', fetchFn),
    action: 'move',
    body: { direction: 'down' },
  },
  {
    name: 'collectStop',
    act: (roundId, orderId, fetchFn) => collectStop(roundId, orderId, undefined, fetchFn),
    action: 'collected',
    body: {},
  },
  {
    name: 'markStopNotFound',
    act: (roundId, orderId, fetchFn) => markStopNotFound(roundId, orderId, fetchFn),
    action: 'not-found',
    body: undefined,
  },
];

describe.each(STOP_ACTIONS)('$name', ({ act, action, body }) => {
  const roundId = ROUND_VIEW.round.id;

  it('posts to /api/collector/rounds/:id/stops/:orderId/<action>, both ids encoded', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await act(ODD_ID, 'e/f?g', fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      `/api/collector/rounds/${ODD_ID_IN_PATH}/stops/e%2Ff%3Fg/${action}`,
    );
    expect(calls[0]?.init?.method).toBe('POST');
    if (body === undefined) {
      expect(calls[0]?.init?.body).toBeUndefined();
      expect(calls[0]?.init?.headers).toBeUndefined();
    } else {
      expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(jsonBodyOf(calls[0])).toEqual(body);
    }
  });

  it('answers saved with the round view on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    const outcome = await act(roundId, ORDER.id, fetchFn);

    expect(outcome).toEqual({ kind: 'saved', view: ROUTED_VIEW });
    if (outcome.kind !== 'saved') throw new Error('expected saved');
    expect(outcome.view.round.createdAt).toBeInstanceOf(Date);
    expect(outcome.view.stops[0]?.order.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUTED_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await act(roundId, ORDER.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers stale with the shared message on a 409 route_not_open', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'route_not_open', message: 'anything' },
    });

    expect(await act(roundId, ORDER.id, fetchFn)).toEqual({
      kind: 'stale',
      message: 'אין מסלול פתוח בסבב הזה. נא לרענן את המסך.',
    });
  });

  it('answers stale with the stop-handled message on a 409 stop_handled or invalid_transition', async () => {
    for (const error of ['stop_handled', 'invalid_transition']) {
      const { fetchFn } = makeFakeFetch({ status: 409, body: { error, message: 'anything' } });
      expect(await act(roundId, ORDER.id, fetchFn), error).toEqual({
        kind: 'stale',
        message: 'העצירה הזאת כבר טופלה. נא לרענן את המסך.',
      });
    }
  });

  it('answers failed on a 409 whose body has no known error code', async () => {
    for (const answer of [
      { status: 409, body: { error: 'confirmations_closed', message: 'x' } },
      { status: 409, body: { message: 'x' } },
      { status: 409, body: ['route_not_open'] },
      { status: 409, text: 'Conflict' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await act(roundId, ORDER.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers notFound on a 404, for a missing round and a missing stop alike', async () => {
    for (const answer of [
      { status: 404, body: { error: 'round_not_found' } },
      { status: 404, body: { error: 'order_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await act(roundId, ORDER.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'notFound',
      });
    }
  });
});

describe('moveStop', () => {
  it('sends the direction it is given', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await moveStop(ROUND_VIEW.round.id, ORDER.id, 'up', fetchFn);

    expect(jsonBodyOf(calls[0])).toEqual({ direction: 'up' });
  });

  it('answers atEdge with the shared message on a 409 stop_at_edge', async () => {
    const { fetchFn } = makeFakeFetch({
      status: 409,
      body: { error: 'stop_at_edge', message: 'anything' },
    });

    expect(await moveStop(ROUND_VIEW.round.id, ORDER.id, 'up', fetchFn)).toEqual({
      kind: 'atEdge',
      message: 'העצירה כבר בקצה המסלול.',
    });
  });

  it('answers failed on a 400 invalid_move: the screen has no field to show it next to', async () => {
    const { fetchFn } = makeFakeFetch({ status: 400, body: { error: 'invalid_move' } });

    expect(await moveStop(ROUND_VIEW.round.id, ORDER.id, 'up', fetchFn)).toEqual({
      kind: 'failed',
    });
  });
});

describe('collectStop', () => {
  it('sends the count it is given', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await collectStop(ROUND_VIEW.round.id, ORDER.id, 12, fetchFn);

    expect(jsonBodyOf(calls[0])).toEqual({ bottlesCollected: 12 });
  });

  it('sends {} without a count, so the api uses the estimate', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    await collectStop(ROUND_VIEW.round.id, ORDER.id, undefined, fetchFn);

    expect(calls[0]?.init?.body).toBe('{}');
  });

  it("answers saved with the collected stop's thank-you row", async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: ROUTED_VIEW });

    const outcome = await collectStop(ROUND_VIEW.round.id, ORDER.id, 45, fetchFn);

    if (outcome.kind !== 'saved') throw new Error('expected saved');
    expect(outcome.view.stops[0]?.thankYou?.url).toBe(
      'https://wa.me/972501234567?text=%D7%AA%D7%95%D7%93%D7%94',
    );
  });

  it('answers invalid with the field errors of a 400 invalid_collect', async () => {
    const fieldErrors = { bottlesCollected: 'נא לכתוב כמה בקבוקים נאספו, מספר שלם מ-1 ומעלה' };
    const { fetchFn } = makeFakeFetch({
      status: 400,
      body: { error: 'invalid_collect', fieldErrors },
    });

    expect(await collectStop(ROUND_VIEW.round.id, ORDER.id, 0, fetchFn)).toEqual({
      kind: 'invalid',
      fieldErrors,
    });
  });

  it('answers invalid with no field errors on a 400 without usable ones', async () => {
    for (const answer of [
      { status: 400, body: { error: 'invalid_collect', fieldErrors: { bottlesCollected: 0 } } },
      { status: 400, body: { error: 'invalid_collect', fieldErrors: ['bottlesCollected'] } },
      { status: 400, body: { error: 'invalid_json' } },
      { status: 400, text: 'Bad Request' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(
        await collectStop(ROUND_VIEW.round.id, ORDER.id, 0, fetchFn),
        JSON.stringify(answer),
      ).toEqual({ kind: 'invalid', fieldErrors: {} });
    }
  });
});

describe('markStopNotFound', () => {
  it('answers failed on a 400: it sends no body, so there is no field to show', async () => {
    const { fetchFn } = makeFakeFetch({ status: 400, body: { error: 'invalid_json' } });

    expect(await markStopNotFound(ROUND_VIEW.round.id, ORDER.id, fetchFn)).toEqual({
      kind: 'failed',
    });
  });
});

/**
 * The routed round once Yoel tapped "סיימתי את הסבב": closed, with `closedAt`. Its second stop was not
 * reached, so that order is back in `waiting` and the stop shows `left`.
 */
const CLOSED_VIEW: RoundView = {
  ...ROUTED_VIEW,
  round: {
    ...ROUTED_VIEW.round,
    status: 'closed',
    closedAt: new Date('2026-11-12T15:30:00.000Z'),
  },
  stops: [
    ROUTED_VIEW.stops[0]!,
    {
      order: {
        ...SECOND_ORDER,
        status: 'waiting',
        lastMiss: { date: '2026-11-12', reason: 'notReached', roundId: ROUND_VIEW.round.id },
      },
      hasLocation: false,
      state: 'left',
    },
  ],
};

describe('closeRound', () => {
  it('posts to /api/collector/rounds/:id/close, the id encoded, no body', async () => {
    const { fetchFn, calls } = makeFakeFetch({ status: 200, body: CLOSED_VIEW });

    await closeRound(ODD_ID, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/api/collector/rounds/${ODD_ID_IN_PATH}/close`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('answers closed with the closed view on 200, Dates parsed', async () => {
    const { fetchFn } = makeFakeFetch({ status: 200, body: CLOSED_VIEW });

    const outcome = await closeRound(ROUND_VIEW.round.id, fetchFn);

    expect(outcome).toEqual({ kind: 'closed', view: CLOSED_VIEW });
    if (outcome.kind !== 'closed') throw new Error('expected closed');
    expect(outcome.view.round.closedAt).toBeInstanceOf(Date);
    expect(outcome.view.stops[1]?.order.createdAt).toBeInstanceOf(Date);
  });

  it('answers failed on a 200 whose body is not a round view', async () => {
    for (const answer of NOT_A_ROUTED_VIEW) {
      const { fetchFn } = makeFakeFetch({ status: 200, ...answer });
      expect(await closeRound(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('answers notFound on a 404', async () => {
    for (const answer of [
      { status: 404, body: { error: 'round_not_found' } },
      { status: 404, text: 'Not Found' },
    ]) {
      const { fetchFn } = makeFakeFetch(answer);
      expect(await closeRound(ROUND_VIEW.round.id, fetchFn), JSON.stringify(answer)).toEqual({
        kind: 'notFound',
      });
    }
  });
});

describeEveryEndpoint([
  {
    name: 'fetchRounds',
    call: (fetchFn) => fetchRounds(fetchFn),
    success: { status: 200, body: { rounds: [ROUND_VIEW] } },
    on401: 'loggedOut',
    alsoFailed: [201, 404, 429],
    failedBody: { rounds: [ROUND_VIEW] },
  },
  {
    name: 'planRound',
    call: (fetchFn) => planRound(PLAN, fetchFn),
    success: { status: 201, body: ROUND_VIEW },
    on401: 'loggedOut',
    alsoFailed: [404, 413, 429],
  },
  {
    name: 'buildRoute',
    call: (fetchFn) => buildRoute(ROUND_VIEW.round.id, fetchFn),
    success: { status: 200, body: ROUTED_VIEW },
    on401: 'loggedOut',
    alsoFailed: [201, 400, 429],
  },
  ...STOP_ACTIONS.map(({ name, act }): EndpointCase => ({
    name,
    call: (fetchFn) => act(ROUND_VIEW.round.id, ORDER.id, fetchFn),
    success: { status: 200, body: ROUTED_VIEW },
    on401: 'loggedOut',
    alsoFailed: [201, 429],
  })),
  {
    name: 'closeRound',
    call: (fetchFn) => closeRound(ROUND_VIEW.round.id, fetchFn),
    success: { status: 200, body: CLOSED_VIEW },
    on401: 'loggedOut',
    // The route has no 409: even a known code there is from something in between.
    alsoFailed: [201, 400, 409, 429],
    failedBody: { error: 'confirmations_closed' },
  },
]);
