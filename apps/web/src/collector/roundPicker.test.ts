import { describe, expect, it } from 'vitest';
import type {
  CollectorOrder,
  CollectorRound,
  RoundGroupKey,
  RoundView,
  RouteStopView,
} from '@bottlerun/shared';
import {
  filterRoundsByRegion,
  pickSelectedRound,
  regionsPresent,
  roundPhaseLabel,
  roundPickerLabel,
  roundPickerParts,
} from './roundPicker.ts';

/** An order of the given id; the picker only counts orders, so the rest is fixed. */
function makeOrder(id: string, overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id,
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 201,
      streetName: 'שד נהר הדן',
      houseNumber: '12',
      bottlesSpot: 'privateHouse',
    },
    bottlesEstimated: 40,
    status: 'pending',
    region: 'ramat',
    source: 'form',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    hasLocation: true,
    ...overrides,
  };
}

/** A stop of a routed round. */
function makeStop(id: string): RouteStopView {
  return { order: makeOrder(id), hasLocation: true, state: 'toCollect' };
}

/**
 * A round's view: an open round on 28/10 in רמת בית שמש, confirming, with no orders. `counts`
 * puts that many orders in each group; `stops` that many stops in the route.
 */
function makeRoundView(
  overrides: Partial<CollectorRound> = {},
  counts: Partial<Record<RoundGroupKey, number>> = {},
  stops = 0,
): RoundView {
  const keys: RoundGroupKey[] = ['confirmed', 'pending', 'otherDate'];
  return {
    round: {
      id: 'r1',
      date: '2026-10-28',
      region: 'ramat',
      status: 'open',
      phase: 'confirming',
      createdAt: new Date('2026-10-20T07:00:00Z'),
      ...overrides,
    },
    groups: keys.map((key) => ({
      key,
      orders: Array.from({ length: counts[key] ?? 0 }, (_, i) => makeOrder(`${key}-${i}`)),
    })),
    sendList: [],
    stops: Array.from({ length: stops }, (_, i) => makeStop(`s${i}`)),
  };
}

const RAMAT_1 = makeRoundView({ id: 'a', date: '2026-10-28', region: 'ramat' });
const OLD_1 = makeRoundView({ id: 'b', date: '2026-10-29', region: 'old' });
const RAMAT_2 = makeRoundView({ id: 'c', date: '2026-11-02', region: 'ramat' });
const ROUNDS = [RAMAT_1, OLD_1, RAMAT_2];

describe('filterRoundsByRegion', () => {
  it('keeps every round for "all"', () => {
    expect(filterRoundsByRegion(ROUNDS, 'all')).toEqual(ROUNDS);
  });

  it('keeps only the rounds of the region, in the api order', () => {
    expect(filterRoundsByRegion(ROUNDS, 'ramat')).toEqual([RAMAT_1, RAMAT_2]);
    expect(filterRoundsByRegion(ROUNDS, 'old')).toEqual([OLD_1]);
  });

  it('returns an empty list when no round is in the region', () => {
    expect(filterRoundsByRegion([RAMAT_1], 'old')).toEqual([]);
  });
});

describe('pickSelectedRound', () => {
  it('returns the round with the requested id', () => {
    expect(pickSelectedRound(ROUNDS, 'b')).toBe(OLD_1);
  });

  it('falls back to the first round for an id that is not in the list', () => {
    expect(pickSelectedRound(ROUNDS, 'closed-meanwhile')).toBe(RAMAT_1);
  });

  it('falls back to the first round when no id is requested, without sorting again', () => {
    expect(pickSelectedRound([RAMAT_2, RAMAT_1], undefined)).toBe(RAMAT_2);
  });

  it('returns undefined when there is no open round', () => {
    expect(pickSelectedRound([], 'a')).toBeUndefined();
    expect(pickSelectedRound([], undefined)).toBeUndefined();
  });
});

describe('regionsPresent', () => {
  it('lists the regions that occur, in region order, each once', () => {
    expect(regionsPresent([OLD_1, RAMAT_1, RAMAT_2])).toEqual(['ramat', 'old']);
  });

  it('leaves out a region with no round', () => {
    expect(regionsPresent([OLD_1])).toEqual(['old']);
  });

  it('is empty without rounds', () => {
    expect(regionsPresent([])).toEqual([]);
  });
});

describe('roundPickerParts and roundPickerLabel', () => {
  it('shows how many confirmed out of all orders while the round is confirming', () => {
    const view = makeRoundView({}, { confirmed: 2, pending: 2, otherDate: 1 });
    expect(roundPickerParts(view)).toEqual({
      date: '28/10',
      region: 'רמת בית שמש',
      summary: 'אישרו 2 מתוך 5',
    });
    expect(roundPickerLabel(view)).toBe('28/10 · רמת בית שמש · אישרו 2 מתוך 5');
  });

  it('shows the number of stops once the round is routed', () => {
    const view = makeRoundView({ phase: 'routed', region: 'old', date: '2026-11-02' }, {}, 7);
    expect(roundPickerLabel(view)).toBe('02/11 · בית שמש · 7 עצירות');
  });

  it('shows zero of zero for a confirming round with no orders', () => {
    expect(roundPickerParts(makeRoundView()).summary).toBe('אישרו 0 מתוך 0');
  });
});

describe('roundPhaseLabel', () => {
  it('names the step of the round', () => {
    expect(roundPhaseLabel(makeRoundView({ phase: 'confirming' }))).toBe('אישורים');
    expect(roundPhaseLabel(makeRoundView({ phase: 'routed' }))).toBe('מסלול');
  });
});
