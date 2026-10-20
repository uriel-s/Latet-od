// Unit tests of buildRouteStops: fixed streets and a distance table the test controls, so the
// expected order never depends on the real street list or real geography.
import { describe, expect, it } from 'vitest';
import type { DistanceMatrix, GeoPoint, Order, Street, StreetLookup } from '@bottlerun/shared';
import { makeNewOrder } from '../orders/makeOrder.ts';
import { buildRouteStops } from './buildRoute.ts';

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
