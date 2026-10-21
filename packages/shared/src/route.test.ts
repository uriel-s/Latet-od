import { describe, expect, it } from 'vitest';
import type { GeoPoint } from './location.ts';
import {
  haversine,
  MAX_EXHAUSTIVE_STOPS,
  planRoute,
  straightLineDistance,
  type DistanceMatrix,
} from './route.ts';

// Made-up round-number points, not real addresses. Points on one meridian (same lng) are on a
// straight line, so the cheapest route along them is obvious.
const LNG = 35.05;
/** A point `steps` hundredths of a degree north of lat 31.75, on the test meridian. */
function onLine(steps: number): GeoPoint {
  return { lat: 31.75 + steps / 100, lng: LNG };
}

interface TestStop {
  name: string;
  point?: GeoPoint;
}

/** A located test stop at `onLine(steps)`, named by its position. */
function stopAt(steps: number): TestStop {
  return { name: `at ${steps}`, point: onLine(steps) };
}

const names = (route: readonly TestStop[]): string[] => route.map((stop) => stop.name);

describe('haversine', () => {
  it('measures one degree of latitude along a meridian as about 111,195 m', () => {
    // 2π × mean radius / 360 = 111,194.9 m.
    const meters = haversine({ lat: 31, lng: 35 }, { lat: 32, lng: 35 });
    expect(Math.abs(meters - 111_195)).toBeLessThan(1);
  });

  it('measures a known city pair, Tel Aviv to Jerusalem, as about 54 km', () => {
    const telAviv = { lat: 32.0853, lng: 34.7818 };
    const jerusalem = { lat: 31.7683, lng: 35.2137 };
    expect(haversine(telAviv, jerusalem)).toBeGreaterThan(53_500);
    expect(haversine(telAviv, jerusalem)).toBeLessThan(55_000);
  });

  it('returns 0 for the same point', () => {
    expect(haversine(onLine(3), onLine(3))).toBe(0);
  });

  it('is symmetric', () => {
    const from = { lat: 31.7, lng: 35 };
    const to = { lat: 31.8, lng: 35.1 };
    expect(haversine(from, to)).toBe(haversine(to, from));
  });
});

describe('straightLineDistance', () => {
  it('answers with haversine', () => {
    expect(straightLineDistance.distance(onLine(0), onLine(5))).toBe(
      haversine(onLine(0), onLine(5)),
    );
  });
});

describe('planRoute', () => {
  const START = onLine(0);
  const END = onLine(10);

  it('returns an empty route for no stops', () => {
    expect(planRoute(START, [], END)).toEqual([]);
  });

  it('returns the single stop of a one-stop round', () => {
    const only = stopAt(4);
    expect(planRoute(START, [only], END)).toEqual([only]);
  });

  it('orders 5 shuffled stops on the line from start to end', () => {
    const stops = [7, 2, 9, 4, 1].map(stopAt);
    expect(names(planRoute(START, stops, END))).toEqual(['at 1', 'at 2', 'at 4', 'at 7', 'at 9']);
  });

  it('finds the optimum where driving to the nearest stop first would be wrong', () => {
    // Nearest first goes to +1, back past the start to -1.5, then all the way to 10 (15 steps).
    // Going to -1.5 first and then forward is 13 steps.
    const stops = [stopAt(1), stopAt(-1.5)];
    expect(names(planRoute(START, stops, END))).toEqual(['at -1.5', 'at 1']);
  });

  it(`orders ${MAX_EXHAUSTIVE_STOPS + 1} shuffled stops on the line (heuristic path)`, () => {
    const stops = [5, 9, 1, 7, 3, 8, 2, 6, 4].map(stopAt);
    expect(stops.length).toBeGreaterThan(MAX_EXHAUSTIVE_STOPS);
    const route = planRoute(START, stops, END);
    expect(names(route)).toEqual([
      'at 1',
      'at 2',
      'at 3',
      'at 4',
      'at 5',
      'at 6',
      'at 7',
      'at 8',
      'at 9',
    ]);
    expect([...route].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...stops].sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it('fixes a wrong nearest-neighbor start with 2-opt for more than 8 stops', () => {
    // Nearest first walks 1..8 and only then goes back to -1.5; reversing runs fixes it.
    const stops = [3, -1.5, 8, 1, 6, 2, 7, 4, 5].map(stopAt);
    expect(names(planRoute(START, stops, END))).toEqual([
      'at -1.5',
      'at 1',
      'at 2',
      'at 3',
      'at 4',
      'at 5',
      'at 6',
      'at 7',
      'at 8',
    ]);
  });

  it('puts a stop without a location last', () => {
    const unlocated: TestStop = { name: 'no point' };
    const stops = [stopAt(6), unlocated, stopAt(3)];
    expect(names(planRoute(START, stops, END))).toEqual(['at 3', 'at 6', 'no point']);
  });

  it('keeps several stops without a location in their original order', () => {
    const stops: TestStop[] = [{ name: 'first' }, stopAt(6), { name: 'second' }, { name: 'third' }];
    expect(names(planRoute(START, stops, END))).toEqual(['at 6', 'first', 'second', 'third']);
  });

  it('keeps the original order when two routes cost the same', () => {
    // Every leg costs the same, so every order is equally cheap.
    const flat: DistanceMatrix = { distance: () => 1 };
    const stops = [stopAt(5), stopAt(2), stopAt(8)];
    expect(planRoute(START, stops, END, flat)).toEqual(stops);
  });

  describe('with a passed DistanceMatrix', () => {
    /**
     * A fake, one-way matrix where only the legs of `cheapOrder` (start → … → end) cost 1 and
     * every other leg, including each cheap leg driven backwards, costs 100.
     */
    function oneWayChain(cheapOrder: readonly GeoPoint[]): DistanceMatrix {
      const key = (point: GeoPoint): string => `${point.lat},${point.lng}`;
      const cheapLegs = new Set(
        cheapOrder.slice(1).map((to, index) => `${key(cheapOrder[index] ?? to)}>${key(to)}`),
      );
      return { distance: (from, to) => (cheapLegs.has(`${key(from)}>${key(to)}`) ? 1 : 100) };
    }

    it('follows the matrix, not the straight line', () => {
      const [a, b, c] = [stopAt(2), stopAt(5), stopAt(8)];
      const matrix = oneWayChain([START, onLine(8), onLine(2), onLine(5), END]);
      expect(names(planRoute(START, [a, b, c], END, matrix))).toEqual(['at 8', 'at 2', 'at 5']);
    });

    it('follows an asymmetric matrix on the heuristic path too', () => {
      // Backwards along the line is cheap; forwards (the straight-line optimum) is expensive.
      const stops = [4, 1, 9, 6, 2, 8, 3, 7, 5].map(stopAt);
      const backwards = [9, 8, 7, 6, 5, 4, 3, 2, 1].map(onLine);
      const matrix = oneWayChain([START, ...backwards, END]);
      expect(names(planRoute(START, stops, END, matrix))).toEqual(
        [9, 8, 7, 6, 5, 4, 3, 2, 1].map((steps) => `at ${steps}`),
      );
    });
  });

  it('does not mutate the input and returns the same stop objects', () => {
    const stops = [stopAt(7), { name: 'no point' }, stopAt(2)];
    const snapshot = [...stops];
    const route = planRoute(START, stops, END);
    expect(stops).toEqual(snapshot);
    stops.forEach((stop, index) => expect(stop).toBe(snapshot[index]));
    expect(route[0]).toBe(stops[2]);
    expect(route[1]).toBe(stops[0]);
    expect(route[2]).toBe(stops[1]);
  });
});
