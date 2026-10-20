// Test data for rounds: a valid NewRound in one call, so a test spells out only the fields it is
// about. Used by the RoundsRepo contract and by the round service and route tests.
import type { NewRound } from '@bottlerun/shared';

/** The moment every made round is created, unless a test overrides it. */
export const MADE_ROUND_CREATED_AT = new Date('2026-11-10T08:30:00.000Z');

/**
 * A valid new round (it passes `roundSchema` once a repo gives it an id): open, in phase
 * `confirming`, region `ramat`, on 2026-11-12, with no orders, no stops, no personal text and no
 * pickup time, created at {@link MADE_ROUND_CREATED_AT}.
 *
 * `overrides` is merged shallowly: `orderIds` or `stops` given here replaces the whole array.
 */
export function makeNewRound(overrides: Partial<NewRound> = {}): NewRound {
  return {
    date: '2026-11-12',
    region: 'ramat',
    status: 'open',
    phase: 'confirming',
    orderIds: [],
    stops: [],
    createdAt: new Date(MADE_ROUND_CREATED_AT),
    ...overrides,
  };
}
