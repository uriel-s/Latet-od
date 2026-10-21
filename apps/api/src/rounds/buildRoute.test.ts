// Unit tests of buildRouteStops (fixed streets and a distance table the test controls, so the
// expected order never depends on the real street list or real geography) and of moveStop.
import { describe, expect, it } from 'vitest';
import type {
  DistanceMatrix,
  GeoPoint,
  Order,
  RoundStop,
  Street,
  StreetLookup,
} from '@bottlerun/shared';
import { makeNewOrder } from '../orders/makeOrder.ts';
import { buildRouteStops, moveStop } from './buildRoute.ts';

// Made-up points on one line (lng is the position): start at 0, the end at 10.
const START: GeoPoint = { lat: 31.7, lng: 0 };
const END: GeoPoint = { lat: 31.7, lng: 10 };
const NEAR_START: Street = { code: 1, name: 'ליד הבית', region: 'ramat', lat: 31.7, lng: 2 };
const MIDDLE: Street = { code: 2, name: 'באמצע', region: 'ramat', lat: 31.7, lng: 5 };
const NEAR_END: Street = { code: 3, name: 'ליד הפריקה', region: 'ramat', lat: 31.7, lng: 8 };
/** In the list, but with no point. */
const NO_POINT: Street = { code: 4, name: 'בלי נקודה', region: 'ramat' };

const STREETS = new Map([NEAR_START, MIDDLE, NEAR_END, NO_POINT].map((s) => [s.code, s]));
const lookup: StreetLookup = (code) => STREETS.get(code);

/** Distance along the line: |Δlng|, so the shortest route visits the stops by lng. */
const alongTheLine: DistanceMatrix = { distance: (from, to) => Math.abs(from.lng - to.lng) };

let nextId = 0;

/** An order with an id, on the street `streetCode` (none: a free-text street), near `nearStreetCode`. */
function orderOn(address: { streetCode?: number; nearStreetCode?: number }): Order {
  nextId += 1;
  const made = makeNewOrder();
  return {
    ...made,
    id: `order-${String(nextId)}`,
    address: { ...made.address, ...address },
  };
}

describe('buildRouteStops', () => {
  it('orders the stops for driving from the start to the end', () => {
    const end = orderOn({ streetCode: NEAR_END.code });
    const start = orderOn({ streetCode: NEAR_START.code });
    const middle = orderOn({ streetCode: MIDDLE.code });

    const stops = buildRouteStops([end, start, middle], START, END, alongTheLine, lookup);

    expect(stops).toStrictEqual([
      { orderId: start.id, hasLocation: true },
      { orderId: middle.id, hasLocation: true },
      { orderId: end.id, hasLocation: true },
    ]);
  });

  it('follows the distance it is given, not the real one', () => {
    const first = orderOn({ streetCode: NEAR_START.code });
    const second = orderOn({ streetCode: NEAR_END.code });
    // Reversed: the farther the point on the line, the cheaper to reach from the start.
    const reversed: DistanceMatrix = { distance: (from, to) => 20 - Math.abs(from.lng - to.lng) };

    const stops = buildRouteStops([first, second], START, END, reversed, lookup);

    expect(stops.map((stop) => stop.orderId)).toStrictEqual([second.id, first.id]);
  });

  it('takes the point of the near street Yoel picked for a free-text street', () => {
    const nearEnd = orderOn({ nearStreetCode: NEAR_END.code });
    const middle = orderOn({ streetCode: MIDDLE.code });

    const stops = buildRouteStops([nearEnd, middle], START, END, alongTheLine, lookup);

    expect(stops).toStrictEqual([
      { orderId: middle.id, hasLocation: true },
      { orderId: nearEnd.id, hasLocation: true },
    ]);
  });

  it('puts the stops without a location last, in the order given, with hasLocation false', () => {
    const freeText = orderOn({});
    const noPoint = orderOn({ streetCode: NO_POINT.code });
    const end = orderOn({ streetCode: NEAR_END.code });
    const start = orderOn({ streetCode: NEAR_START.code });

    const stops = buildRouteStops(
      [freeText, end, noPoint, start],
      START,
      END,
      alongTheLine,
      lookup,
    );

    expect(stops).toStrictEqual([
      { orderId: start.id, hasLocation: true },
      { orderId: end.id, hasLocation: true },
      { orderId: freeText.id, hasLocation: false },
      { orderId: noPoint.id, hasLocation: false },
    ]);
  });

  it('gives no stops for no orders', () => {
    expect(buildRouteStops([], START, END, alongTheLine, lookup)).toStrictEqual([]);
  });

  it('never changes the orders it is given', () => {
    const orders = [orderOn({ streetCode: NEAR_END.code }), orderOn({ streetCode: MIDDLE.code })];
    const copy = structuredClone(orders);

    buildRouteStops(orders, START, END, alongTheLine, lookup);

    expect(orders).toStrictEqual(copy);
  });
});

describe('moveStop', () => {
  // A route of four stops; `d` had no location when the route was built.
  const ROUTE: readonly RoundStop[] = [
    { orderId: 'a', hasLocation: true },
    { orderId: 'b', hasLocation: true },
    { orderId: 'c', hasLocation: true },
    { orderId: 'd', hasLocation: false },
  ];
  const ids = (stops: RoundStop[] | string): string[] | string =>
    typeof stops === 'string' ? stops : stops.map((stop) => stop.orderId);

  it('swaps a stop moved up with the one before it, leaving the rest in place', () => {
    expect(ids(moveStop(ROUTE, 'c', 'up'))).toStrictEqual(['a', 'c', 'b', 'd']);
  });

  it('swaps a stop moved down with the one after it, leaving the rest in place', () => {
    expect(ids(moveStop(ROUTE, 'b', 'down'))).toStrictEqual(['a', 'c', 'b', 'd']);
  });

  it('keeps each stop’s stored hasLocation as it moves', () => {
    expect(moveStop(ROUTE, 'd', 'up')).toStrictEqual([
      { orderId: 'a', hasLocation: true },
      { orderId: 'b', hasLocation: true },
      { orderId: 'd', hasLocation: false },
      { orderId: 'c', hasLocation: true },
    ]);
  });

  it('refuses the first stop moving up and the last moving down with atEdge', () => {
    expect(moveStop(ROUTE, 'a', 'up')).toBe('atEdge');
    expect(moveStop(ROUTE, 'd', 'down')).toBe('atEdge');
  });

  it('refuses both directions for the only stop with atEdge', () => {
    const single: RoundStop[] = [{ orderId: 'a', hasLocation: true }];
    expect(moveStop(single, 'a', 'up')).toBe('atEdge');
    expect(moveStop(single, 'a', 'down')).toBe('atEdge');
  });

  it('answers notFound for an order that is no stop, also in an empty route', () => {
    expect(moveStop(ROUTE, 'z', 'up')).toBe('notFound');
    expect(moveStop([], 'a', 'down')).toBe('notFound');
  });

  it('never changes the stops it is given', () => {
    const copy = structuredClone(ROUTE);

    moveStop(ROUTE, 'b', 'up');

    expect(ROUTE).toStrictEqual(copy);
  });
});
