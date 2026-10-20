import { describe, expect, it } from 'vitest';
import {
  MAX_ROUND_ORDERS,
  ROUND_PHASES,
  ROUND_STATUSES,
  roundPhaseSchema,
  roundSchema,
  roundStatusSchema,
  type Round,
} from './round.ts';

const CREATED_AT = new Date('2026-11-04T17:00:00.000Z');
const CLOSED_AT = new Date('2026-11-05T12:30:00.000Z');

/** A stored open round, as the repo returns it from Mongo (Dates, not strings). */
function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: '6720a1b2c3d4e5f6a7b8c9d0',
    date: '2026-11-05',
    region: 'ramat',
    status: 'open',
    phase: 'confirming',
    personalText: 'השבוע נגיע מוקדם.\nתודה!',
    pickupBy: '08:00',
    orderIds: ['6710f3a2c4b5d6e7f8a9b0c1', '6710f3a2c4b5d6e7f8a9b0c2'],
    stops: [],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('round constants', () => {
  it('caps a round at 25 orders (spec §1)', () => {
    expect(MAX_ROUND_ORDERS).toBe(25);
  });

  it('lists the statuses and phases, in order', () => {
    expect(roundStatusSchema.options).toEqual([...ROUND_STATUSES]);
    expect(ROUND_STATUSES).toEqual(['open', 'closed']);
    expect(roundPhaseSchema.options).toEqual([...ROUND_PHASES]);
    expect(ROUND_PHASES).toEqual(['confirming', 'routed']);
  });
});

describe('roundSchema', () => {
  it('accepts a stored round with Dates', () => {
    const round = makeRound();
    expect(roundSchema.parse(round)).toEqual(round);
  });

  it('accepts a closed, routed round with stops and closedAt', () => {
    const round = makeRound({
      status: 'closed',
      phase: 'routed',
      stops: [{ orderId: '6710f3a2c4b5d6e7f8a9b0c2' }, { orderId: '6710f3a2c4b5d6e7f8a9b0c1' }],
      closedAt: CLOSED_AT,
    });
    expect(roundSchema.parse(round)).toEqual(round);
  });

  // The api's JSON carries ISO strings; the same schema reads them back into Dates on the web.
  it('parses the ISO strings of an api response into Dates', () => {
    const json = JSON.parse(JSON.stringify(makeRound({ closedAt: CLOSED_AT }))) as unknown;
    const parsed = roundSchema.parse(json);
    expect(parsed.createdAt).toEqual(CREATED_AT);
    expect(parsed.closedAt).toEqual(CLOSED_AT);
  });

  it('accepts a round without personalText and pickupBy', () => {
    const round = makeRound();
    delete round.personalText;
    delete round.pickupBy;
    expect(roundSchema.parse(round)).toEqual(round);
  });

  it('rejects a date that is not a real YYYY-MM-DD day', () => {
    for (const date of ['', '05/11/2026', '2026-11-5', '2026-02-30', '2026-11-05T00:00:00Z']) {
      expect(roundSchema.safeParse(makeRound({ date })).success, date).toBe(false);
    }
  });

  it('rejects an unknown region, status or phase', () => {
    const bad = (overrides: Record<string, unknown>) =>
      roundSchema.safeParse({ ...makeRound(), ...overrides }).success;
    expect(bad({ region: 'jerusalem' })).toBe(false);
    expect(bad({ region: undefined })).toBe(false);
    expect(bad({ status: 'archived' })).toBe(false);
    expect(bad({ phase: 'done' })).toBe(false);
  });

  it('rejects a pickupBy that is not HH:MM, and an empty personalText', () => {
    for (const pickupBy of ['8:00', '24:00', '', '08:00:00']) {
      expect(roundSchema.safeParse(makeRound({ pickupBy })).success, pickupBy).toBe(false);
    }
    expect(roundSchema.safeParse(makeRound({ personalText: '' })).success).toBe(false);
  });

  it('rejects an empty order id, a stop without an order and a null timestamp', () => {
    expect(roundSchema.safeParse(makeRound({ orderIds: [''] })).success).toBe(false);
    expect(roundSchema.safeParse({ ...makeRound(), stops: [{}] }).success).toBe(false);
    expect(roundSchema.safeParse({ ...makeRound(), closedAt: null }).success).toBe(false);
  });

  // Mongo's `_id` and anything else unknown must not leak into what the api returns.
  it('strips unknown keys', () => {
    const parsed = roundSchema.parse({ ...makeRound(), _id: 'mongo', extra: 1 });
    expect(parsed).not.toHaveProperty('_id');
    expect(parsed).not.toHaveProperty('extra');
  });
});
