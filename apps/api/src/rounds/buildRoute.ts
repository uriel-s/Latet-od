// The stored route of a round (spec §3.6 "סגור אישורים ובנה מסלול", ADR-0005): the round's
// confirmed orders, ordered for driving from the start (Yoel's home) to the drop-off, as the
// `RoundStop`s the round keeps. Pure: collectorRoundsRoutes.ts decides which orders are stops,
// passes the start, end and distances from its deps, and writes the result once.
import {
  findStreet,
  planRoute,
  pointForAddress,
  type DistanceMatrix,
  type GeoPoint,
  type Order,
  type RoundStop,
  type RouteStopInput,
  type StreetLookup,
} from '@bottlerun/shared';

/** One stop on its way through planRoute: its order, and its point when the address has one. */
interface StopInput extends RouteStopInput {
  order: Order;
}

/**
 * The route's stops for `stopOrders`, in driving order: `start` → stops → `end` (the two ends are
 * not returned). Each order's point is its address's (`pointForAddress`: the near street first,
 * then the street picked from the list); an order without one cannot be placed, so planRoute puts
 * it last, in the given order, and its stop gets `hasLocation: false` (the "בלי מיקום" tag).
 *
 * `hasLocation` is stored rather than re-derived later: a stop keeps the place the route gave it
 * even if Yoel picks a near street afterwards (see `roundStopSchema`). Empty input gives `[]`.
 *
 * @param stopOrders The orders that become stops, in plan order (`round.orderIds`), which also
 *   decides ties and the order of the stops without a location.
 * @param lookup Finds a street by code; the real list unless a test passes fixed streets.
 */
export function buildRouteStops(
  stopOrders: readonly Order[],
  start: GeoPoint,
  end: GeoPoint,
  distance: DistanceMatrix,
  lookup: StreetLookup = findStreet,
): RoundStop[] {
  const inputs = stopOrders.map((order): StopInput => {
    const point = pointForAddress(order.address, lookup);
    // exactOptionalPropertyTypes: an absent point is a missing key, not `point: undefined`.
    return point === undefined ? { order } : { order, point };
  });
  return planRoute(start, inputs, end, distance).map((input) => ({
    orderId: input.order.id,
    hasLocation: input.point !== undefined,
  }));
}
