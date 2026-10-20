// Unit tests of MongoRoundsRepo's pure parts: documents, queries and updates. No test connects to
// a database: the class only hands these to the driver, and its behaviour against Atlas is checked
// by hand with the contract suite (outside green).
import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { makeNewRound } from './makeRound.ts';
import {
  buildRoundListFilter,
  buildRoundUpdate,
  toRound,
  toRoundDocument,
} from './mongoRoundsRepo.ts';

const HEX_ID = '0123456789abcdef01234567';

describe('toRoundDocument', () => {
  it('is the round with the given _id', () => {
    const round = makeNewRound({ personalText: 'נאסוף אחרי מנחה', pickupBy: '16:00' });
    const _id = new ObjectId();

    expect(toRoundDocument(round, _id)).toEqual({ ...round, _id });
  });

  it('leaves out undefined fields', () => {
    const round = makeNewRound({ personalText: undefined, pickupBy: undefined });

    const doc = toRoundDocument(round, new ObjectId());

    expect('personalText' in doc).toBe(false);
    expect('pickupBy' in doc).toBe(false);
  });

  it('shares nothing with the caller, arrays and dates included', () => {
    const round = makeNewRound({ orderIds: [HEX_ID] });
    const doc = toRoundDocument(round, new ObjectId());

    round.orderIds.push('changed');
    round.createdAt.setTime(0);

    expect(doc.orderIds).toEqual([HEX_ID]);
    expect(doc.createdAt.getTime()).not.toBe(0);
  });
});

describe('toRound', () => {
  it('maps _id to the hex id and drops _id', () => {
    const _id = ObjectId.createFromHexString(HEX_ID);
    const round = makeNewRound();

    const result = toRound({ ...round, _id });

    expect(result).toEqual({ ...round, id: HEX_ID });
    expect('_id' in result).toBe(false);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('reads back what toRoundDocument stores', () => {
    const round = makeNewRound({
      status: 'closed',
      phase: 'routed',
      orderIds: [HEX_ID],
      stops: [{ orderId: HEX_ID }],
      closedAt: new Date('2026-11-12T15:00:00.000Z'),
    });
    const _id = new ObjectId();

    expect(toRound(toRoundDocument(round, _id))).toEqual({ ...round, id: _id.toHexString() });
  });

  it('rejects a document with null in an optional field', () => {
    const doc = { ...makeNewRound(), _id: new ObjectId(), personalText: null };

    expect(() => toRound(doc)).toThrow();
  });

  it('rejects a document missing a required field', () => {
    const doc: Record<string, unknown> & { _id: ObjectId } = {
      ...makeNewRound(),
      _id: new ObjectId(),
    };
    delete doc.date;

    expect(() => toRound(doc)).toThrow();
  });
});

describe('buildRoundListFilter', () => {
  it('matches every round without a filter', () => {
    expect(buildRoundListFilter({})).toEqual({});
  });

  it('filters by statuses with $in', () => {
    expect(buildRoundListFilter({ statuses: ['open'] })).toEqual({ status: { $in: ['open'] } });
  });

  it('keeps an empty status list, which matches nothing', () => {
    expect(buildRoundListFilter({ statuses: [] })).toEqual({ status: { $in: [] } });
  });
});

describe('buildRoundUpdate', () => {
  it('sets the fields with a value and unsets the undefined ones', () => {
    const closedAt = new Date('2026-11-12T15:00:00.000Z');

    const update = buildRoundUpdate({ status: 'closed', closedAt, personalText: undefined });

    expect(update).toEqual({
      $set: { status: 'closed', closedAt },
      $unset: { personalText: '' },
    });
  });

  it('replaces an array as a whole', () => {
    const stops = [{ orderId: HEX_ID }];

    expect(buildRoundUpdate({ stops })).toEqual({ $set: { stops } });
  });

  it('returns null for an empty patch', () => {
    expect(buildRoundUpdate({})).toBeNull();
  });
});
