// Unit tests of leaveRoundPatch: the patch that sends an order back to `waiting`, out of its
// round, with the reason in `lastMiss` (spec §4 "יציאה מסבב"). Pure; the last tests apply the patch
// through the in-memory repo to see what is stored.
import { describe, expect, it } from 'vitest';
import {
  missReasonSchema,
  orderSchema,
  type MessageLogEntry,
  type NewOrder,
  type Order,
  type Round,
} from '@bottlerun/shared';
import { InMemoryOrdersRepo } from '../orders/inMemoryOrdersRepo.ts';
import { makeNewOrder } from '../orders/makeOrder.ts';
import { leaveRoundPatch } from './leaveRound.ts';
import { makeNewRound } from './makeRound.ts';

const ROUND_ID = '6650a1b2c3d4e5f6a7b8c9d0';
const OTHER_ROUND_ID = '6650a1b2c3d4e5f6a7b8c9d1';
const NOW = new Date('2026-11-11T18:45:00.000Z');

const ROUND: Round = { ...makeNewRound({ date: '2026-11-12' }), id: ROUND_ID };

const CONFIRM_REQUEST: MessageLogEntry = {
  kind: 'confirmRequest',
  at: new Date('2026-11-10T09:00:00.000Z'),
  mode: 'manual',
  url: 'https://wa.me/972500000000?text=confirm',
};

/** A stored-looking order: pending in {@link ROUND}, with a confirmation request in its log. */
function orderInRound(overrides: Partial<NewOrder> = {}): Order {
  return {
    ...makeNewOrder({
      status: 'pending',
      roundId: ROUND_ID,
      messages: [CONFIRM_REQUEST],
      ...overrides,
    }),
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  };
}

describe('leaveRoundPatch', () => {
  it('sends the order back to waiting, out of the round, with the round date and the reason', () => {
    const patch = leaveRoundPatch(orderInRound(), ROUND, 'askedOtherDate', NOW);

    expect(patch).toStrictEqual({
      status: 'waiting',
      roundId: undefined,
      lastMiss: { date: '2026-11-12', reason: 'askedOtherDate', roundId: ROUND_ID },
      updatedAt: NOW,
    });
  });

  it('removes roundId: the key is present with the value undefined ($unset)', () => {
    const patch = leaveRoundPatch(orderInRound(), ROUND, 'notConfirmed', NOW);

    expect(Object.keys(patch)).toContain('roundId');
    expect(patch.roundId).toBeUndefined();
  });

  it('touches nothing but status, roundId, lastMiss and updatedAt: never the message log', () => {
    const patch = leaveRoundPatch(orderInRound(), ROUND, 'notFound', NOW);

    expect(Object.keys(patch).sort()).toStrictEqual(
      ['lastMiss', 'roundId', 'status', 'updatedAt'].sort(),
    );
  });

  it('gives updatedAt its own copy of now', () => {
    const patch = leaveRoundPatch(orderInRound(), ROUND, 'notReached', NOW);

    expect(patch.updatedAt).toStrictEqual(NOW);
    expect(patch.updatedAt).not.toBe(NOW);
  });

  it.each(missReasonSchema.options)('records the reason %s', (reason) => {
    const patch = leaveRoundPatch(orderInRound(), ROUND, reason, NOW);

    expect(patch.lastMiss?.reason).toBe(reason);
  });

  it('replaces an earlier miss with this one', () => {
    const order = orderInRound({
      lastMiss: { date: '2026-10-01', reason: 'notFound', roundId: OTHER_ROUND_ID },
    });

    const patch = leaveRoundPatch(order, ROUND, 'askedOtherDate', NOW);

    expect(patch.lastMiss).toStrictEqual({
      date: '2026-11-12',
      reason: 'askedOtherDate',
      roundId: ROUND_ID,
    });
  });

  it('records no miss without the round, but still takes the order out of it', () => {
    const patch = leaveRoundPatch(orderInRound(), null, 'askedOtherDate', NOW);

    expect(patch).toStrictEqual({ status: 'waiting', roundId: undefined, updatedAt: NOW });
    expect(patch).not.toHaveProperty('lastMiss');
  });

  it('records no miss for a round that is not the order’s', () => {
    const otherRound: Round = { ...ROUND, id: OTHER_ROUND_ID, date: '2026-12-01' };

    const patch = leaveRoundPatch(orderInRound(), otherRound, 'askedOtherDate', NOW);

    expect(patch).not.toHaveProperty('lastMiss');
    expect(patch.status).toBe('waiting');
  });

  it('works for a confirmed order too', () => {
    const patch = leaveRoundPatch(orderInRound({ status: 'confirmed' }), ROUND, 'notFound', NOW);

    expect(patch.status).toBe('waiting');
    expect(patch.lastMiss).toStrictEqual({
      date: '2026-11-12',
      reason: 'notFound',
      roundId: ROUND_ID,
    });
  });
});

describe('leaveRoundPatch, as stored', () => {
  it('leaves a valid waiting order with no roundId, its lastMiss, and its message log intact', async () => {
    const orders = new InMemoryOrdersRepo();
    const stored = await orders.create(
      makeNewOrder({ status: 'pending', roundId: ROUND_ID, messages: [CONFIRM_REQUEST] }),
    );

    const updated = await orders.update(
      stored.id,
      leaveRoundPatch(stored, ROUND, 'askedOtherDate', NOW),
      { ifStatus: [stored.status] },
    );

    const expected: Order = {
      ...stored,
      status: 'waiting',
      lastMiss: { date: '2026-11-12', reason: 'askedOtherDate', roundId: ROUND_ID },
      updatedAt: NOW,
    };
    delete expected.roundId;
    expect(updated).toStrictEqual(expected);
    expect(updated).not.toHaveProperty('roundId');
    expect(updated?.messages).toStrictEqual([CONFIRM_REQUEST]);
    expect(orderSchema.safeParse(updated).success).toBe(true);
  });
});
