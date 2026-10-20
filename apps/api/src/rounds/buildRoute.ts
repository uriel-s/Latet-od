// The stored route of a round (spec §3.6 "סגור אישורים ובנה מסלול", ADR-0005): the round's
// confirmed orders, ordered for driving from the start (Yoel's home) to the drop-off, as the
// `RoundStop`s the round keeps; and Yoel's manual move of one stop up or down in it (spec §3.6
// step 2). Pure: collectorRoundsRoutes.ts decides which orders are stops, passes the start, end
// and distances from its deps, writes the built route once, and writes each move.
import {
  findStreet,
  planRoute,
  pointForAddress,
  type DistanceMatrix,
  type GeoPoint,
  type MoveStopRequest,
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

/** Why {@link moveStop} moved nothing: the order is no stop, or the stop is already at that end. */
export type MoveStopRefusal = 'notFound' | 'atEdge';

/**
 * `stops` with the stop of `orderId` swapped with its neighbour: the one before it for `up`, the
 * one after it for `down` (spec §3.6 step 2: "אפשר להזיז עצירה למעלה או למטה ידנית"). Every other
 * stop keeps its place, and each stop keeps its stored `hasLocation`: the route is never
 * recomputed, only Yoel's one change is applied. A new array; `stops` is not changed.
 *
 * Any stop may be moved, whatever its state (collected, not found, left the round): the route
 * screen sorts the handled cards itself (section 6), so the stored order only has to be what Yoel
 * asked for.
 *
 * @returns The moved stops; `'notFound'` when no stop has `orderId`; `'atEdge'` for the first
 *   stop moving `up` or the last moving `down`.
 */
export function moveStop(
  stops: readonly RoundStop[],
  orderId: string,
  direction: MoveStopRequest['direction'],
): RoundStop[] | MoveStopRefusal {
  const from = stops.findIndex((stop) => stop.orderId === orderId);
  if (from === -1) return 'notFound';
  const to = direction === 'up' ? from - 1 : from + 1;
  const moving = stops[from];
  const neighbour = stops[to];
  // Out of range at either end; `moving` is always there (found above), but the check keeps
  // noUncheckedIndexedAccess honest.
  if (moving === undefined || neighbour === undefined) return 'atEdge';
  const moved = [...stops];
  moved[to] = moving;
  moved[from] = neighbour;
  return moved;
}
