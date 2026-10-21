// Orders a round's stops into a driving route: start (Yoel's home) → stops → drop-off (ADR-0005).
// Pure and synchronous: the api computes the route once when a round is planned and stores it.
import type { GeoPoint } from './location.ts';

/** Mean Earth radius in metres (IUGG), used by {@link haversine}. */
export const EARTH_RADIUS_METERS = 6_371_008.8;

/** Degrees to radians. */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle ("קו אוויר") distance between two points, in metres. Good enough to order stops
 * inside one city; it is never used to navigate (Waze does that).
 */
export function haversine(from: GeoPoint, to: GeoPoint): number {
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(deltaLng / 2) ** 2;
  // min() guards against a float a hair above 1, which would make asin return NaN.
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The cost of driving from one point to another: metres, or any consistent non-negative unit.
 * It may be asymmetric (one-way streets), so planRoute never assumes `a→b` equals `b→a`.
 *
 * Synchronous on purpose, so {@link planRoute} stays pure. A later road-distance source (an OSRM
 * `/table` call, ADR-0005 option ג) would fetch its whole table first and then answer lookups
 * through this same interface, without changing planRoute or its callers.
 */
export interface DistanceMatrix {
  distance(from: GeoPoint, to: GeoPoint): number;
}

/** Straight-line distance ("קו אוויר"), the MVP choice in ADR-0005 (option א). */
export const straightLineDistance: DistanceMatrix = { distance: haversine };

/**
 * Up to this many located stops, planRoute tries every order and returns the true optimum.
 * A round has about 5 stops, and 8! = 40,320 orders is still instant; above it (the round cap is
 * 25) it falls back to nearest neighbor + 2-opt.
 */
export const MAX_EXHAUSTIVE_STOPS = 8;

/** What planRoute needs from a stop. Absent `point`: the "בלי מיקום" tag (ADR-0005). */
export interface RouteStopInput {
  point?: GeoPoint;
}

/** A stop known to have a point, kept with that point so it need not be re-checked. */
type LocatedStop<S> = { stop: S; point: GeoPoint };

/** Two costs closer than this are equal, so float noise cannot make 2-opt loop forever. */
const EPSILON = 1e-9;

/** The cost between matrix indices `from` and `to`. */
type CostLookup = (from: number, to: number) => number;

/**
 * Orders a round's stops for driving: start → stops → end, with the smallest total cost. Start
 * and end are fixed and not returned. Returns the same stop objects (by reference) so callers
 * keep their own data; never mutates `stops`. Stops without a `point` cannot be placed, so they
 * go last, in their original order. Equal-cost routes keep the original order (deterministic).
 *
 * Computed once when a round is planned and stored in the round (spec §3.6), so speed only has
 * to be "instant for 25 stops", not more.
 */
export function planRoute<S extends RouteStopInput>(
  start: GeoPoint,
  stops: readonly S[],
  end: GeoPoint,
  distance: DistanceMatrix = straightLineDistance,
): S[] {
  const located: LocatedStop<S>[] = [];
  const unlocated: S[] = [];
  for (const stop of stops) {
    if (stop.point === undefined) unlocated.push(stop);
    else located.push({ stop, point: stop.point });
  }
  if (located.length <= 1) return [...located.map(({ stop }) => stop), ...unlocated];

  // Matrix indices: 0 = start, 1..n = located stops in input order, n + 1 = end. Each ordered
  // pair is asked once, so a slow DistanceMatrix (a table lookup later) is not asked 40,320 times.
  const points = [start, ...located.map(({ point }) => point), end];
  const size = points.length;
  const matrix = new Float64Array(size * size);
  points.forEach((from, fromIndex) => {
    points.forEach((to, toIndex) => {
      if (fromIndex !== toIndex) matrix[fromIndex * size + toIndex] = distance.distance(from, to);
    });
  });
  const cost: CostLookup = (from, to) => matrix[from * size + to] ?? Infinity;

  const stopCount = located.length;
  const order =
    stopCount <= MAX_EXHAUSTIVE_STOPS
      ? bestOrderExhaustive(stopCount, cost)
      : bestOrderHeuristic(stopCount, cost);
  // Matrix index i is located[i - 1]; flatMap only satisfies noUncheckedIndexedAccess.
  const ordered = order.flatMap((index) => located[index - 1]?.stop ?? []);
  return [...ordered, ...unlocated];
}

/**
 * The cheapest order of stops 1..stopCount between start 0 and end stopCount + 1, by trying every
 * order (depth-first, lower indices first). A branch stops as soon as its partial cost can no
 * longer beat the best route found (costs are non-negative). The best is replaced only on a
 * strictly smaller cost, so the first order found, the input order, wins ties.
 */
function bestOrderExhaustive(stopCount: number, cost: CostLookup): number[] {
  const endIndex = stopCount + 1;
  const visited = new Array<boolean>(stopCount + 1).fill(false);
  const current: number[] = [];
  let best: number[] = [];
  let bestCost = Infinity;

  const visit = (last: number, partialCost: number): void => {
    if (partialCost >= bestCost - EPSILON) return;
    if (current.length === stopCount) {
      const total = partialCost + cost(last, endIndex);
      if (total < bestCost - EPSILON) {
        bestCost = total;
        best = [...current];
      }
      return;
    }
    for (let next = 1; next <= stopCount; next++) {
      if (visited[next]) continue;
      visited[next] = true;
      current.push(next);
      visit(next, partialCost + cost(last, next));
      current.pop();
      visited[next] = false;
    }
  };
  visit(0, 0);
  return best;
}

/**
 * A good (not always optimal) order for more than {@link MAX_EXHAUSTIVE_STOPS} stops: nearest
 * neighbor from the start (ties → lower index), then 2-opt with fixed ends until no move helps.
 */
function bestOrderHeuristic(stopCount: number, cost: CostLookup): number[] {
  return improveByTwoOpt(nearestNeighborOrder(stopCount, cost), cost);
}

/** Greedy order: from the start, always drive to the closest stop not yet visited. */
function nearestNeighborOrder(stopCount: number, cost: CostLookup): number[] {
  const remaining = new Set(Array.from({ length: stopCount }, (_, offset) => offset + 1));
  const order: number[] = [];
  let last = 0;
  while (remaining.size > 0) {
    let nearest = -1;
    let nearestCost = Infinity;
    // A Set iterates in insertion order (ascending), and only a strictly closer stop replaces
    // the nearest, so a tie goes to the lower index.
    for (const candidate of remaining) {
      const candidateCost = cost(last, candidate);
      if (nearest === -1 || candidateCost < nearestCost - EPSILON) {
        nearest = candidate;
        nearestCost = candidateCost;
      }
    }
    order.push(nearest);
    remaining.delete(nearest);
    last = nearest;
  }
  return order;
}

/**
 * 2-opt with fixed ends: reverses a run of stops whenever that strictly lowers the total cost,
 * until no reversal does. The reversed route's full cost is recomputed (not the classic
 * two-edge delta), because with an asymmetric matrix the reversed run's inner legs change too.
 * O(n³) per pass, fine for the round cap of 25.
 */
function improveByTwoOpt(initialOrder: readonly number[], cost: CostLookup): number[] {
  const endIndex = initialOrder.length + 1;
  let order = [...initialOrder];
  let orderCost = routeCost(order, endIndex, cost);
  let improved = true;
  while (improved) {
    improved = false;
    for (let first = 0; first < order.length - 1; first++) {
      for (let last = first + 1; last < order.length; last++) {
        const candidate = [
          ...order.slice(0, first),
          ...order.slice(first, last + 1).reverse(),
          ...order.slice(last + 1),
        ];
        const candidateCost = routeCost(candidate, endIndex, cost);
        if (candidateCost < orderCost - EPSILON) {
          order = candidate;
          orderCost = candidateCost;
          improved = true;
        }
      }
    }
  }
  return order;
}

/** Total cost of start 0 → `order` → `endIndex`. */
function routeCost(order: readonly number[], endIndex: number, cost: CostLookup): number {
  let total = 0;
  let last = 0;
  for (const index of order) {
    total += cost(last, index);
    last = index;
  }
  return total + cost(last, endIndex);
}
