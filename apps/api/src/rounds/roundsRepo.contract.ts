// The behaviour every RoundsRepo must have, as a reusable Vitest suite. The in-memory fake runs it
// in inMemoryRoundsRepo.test.ts; the Mongo repo runs the same suite by hand against Atlas (see
// MongoRoundsRepo), so the fake the other tests rely on is proven to behave like the real
// database. Deliberately not named *.test.ts: it only declares tests when an implementation calls it.
import { beforeEach, describe, expect, it } from 'vitest';
import { roundSchema, type Round, type RoundStop } from '@bottlerun/shared';
import { makeNewRound, MADE_ROUND_CREATED_AT } from './makeRound.ts';
import type { RoundPatch, RoundsRepo } from './roundsRepo.ts';

/** Well-formed (ObjectId-shaped) but never handed out by a fresh repo in practice. */
const UNKNOWN_ID = '0123456789abcdef01234567';

/** Ids no implementation can have issued: they must give null, not an error. */
const MALFORMED_IDS = ['nope', '../x', '', '0123456789abcdef012345678'];

/** Order ids for rounds' `orderIds` and `stops`: any non-empty strings will do for the repo. */
const [ORDER_A, ORDER_B, ORDER_C] = [
  'aaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccccccc',
] as const;

/** A fresh copy of the three order ids, so no test shares an array with another. */
function orderIds(): string[] {
  return [ORDER_A, ORDER_B, ORDER_C];
}

/** `MADE_ROUND_CREATED_AT` plus `minutes`. */
function minutesLater(minutes: number): Date {
  return new Date(MADE_ROUND_CREATED_AT.getTime() + minutes * 60_000);
}

/**
 * Declares the RoundsRepo contract tests for one implementation.
 *
 * @param name Shown in the test names, e.g. 'InMemoryRoundsRepo'.
 * @param makeRepo Called before every test; must return an EMPTY repo (for a real database:
 *   a fresh or emptied collection), since the tests count and list everything in it.
 */
export function describeRoundsRepoContract(
  name: string,
  makeRepo: () => RoundsRepo | Promise<RoundsRepo>,
): void {
  describe(`RoundsRepo contract: ${name}`, () => {
    let repo: RoundsRepo;

    beforeEach(async () => {
      repo = await makeRepo();
    });

    /** The stored round with this id; fails the test if there is none. */
    async function mustFind(id: string): Promise<Round> {
      const round = await repo.findById(id);
      if (round === null) return expect.fail(`round ${id} not found`);
      return round;
    }

    /** Ids of `rounds`, to compare lists by identity and order. */
    function ids(rounds: readonly Round[]): string[] {
      return rounds.map((round) => round.id);
    }

    describe('create', () => {
      it('returns the round with a new id, in the stored round shape', async () => {
        const input = makeNewRound({
          personalText: 'נאסוף אחרי מנחה',
          pickupBy: '16:00',
          orderIds: orderIds(),
        });

        const created = await repo.create(input);

        expect(created.id).toMatch(/^[0-9a-f]{24}$/);
        expect(created).toEqual({ ...input, id: created.id });
        // roundSchema strips unknown keys (such as Mongo's _id): nothing may be lost to it.
        expect(roundSchema.parse(created)).toEqual(created);
        expect(created.createdAt).toBeInstanceOf(Date);
      });

      it('gives every round its own id', async () => {
        const first = await repo.create(makeNewRound());
        const second = await repo.create(makeNewRound());

        expect(second.id).not.toBe(first.id);
      });

      it('makes the round findable by id', async () => {
        const created = await repo.create(makeNewRound());

        expect(await repo.findById(created.id)).toEqual(created);
      });

      it('leaves out fields whose value is undefined', async () => {
        const input = makeNewRound({ personalText: undefined, pickupBy: undefined });

        const created = await repo.create(input);
        const found = await mustFind(created.id);

        for (const round of [created, found]) {
          expect('personalText' in round).toBe(false);
          expect('pickupBy' in round).toBe(false);
          expect('closedAt' in round).toBe(false);
        }
      });
    });

    describe('findById', () => {
      it('returns null for an unknown id', async () => {
        await repo.create(makeNewRound());

        expect(await repo.findById(UNKNOWN_ID)).toBeNull();
      });

      it.each(MALFORMED_IDS)('returns null for the malformed id %j', async (id) => {
        await repo.create(makeNewRound());

        expect(await repo.findById(id)).toBeNull();
      });
    });

    describe('list', () => {
      it('returns every round, by date', async () => {
        const later = await repo.create(makeNewRound({ date: '2026-12-01' }));
        const earliest = await repo.create(makeNewRound({ date: '2026-11-03' }));
        const middle = await repo.create(makeNewRound({ date: '2026-11-20' }));

        expect(ids(await repo.list())).toEqual([earliest.id, middle.id, later.id]);
      });

      it('orders rounds of the same date by createdAt', async () => {
        const second = await repo.create(makeNewRound({ createdAt: minutesLater(10) }));
        const first = await repo.create(makeNewRound({ createdAt: minutesLater(0) }));
        const otherDay = await repo.create(
          makeNewRound({ date: '2026-11-11', createdAt: minutesLater(20) }),
        );

        expect(ids(await repo.list())).toEqual([otherDay.id, first.id, second.id]);
      });

      it('keeps creation order for rounds of the same date and moment', async () => {
        const first = await repo.create(makeNewRound());
        const second = await repo.create(makeNewRound());
        const third = await repo.create(makeNewRound());

        expect(ids(await repo.list())).toEqual([first.id, second.id, third.id]);
      });

      it('returns nothing from an empty repo', async () => {
        expect(await repo.list()).toEqual([]);
      });

      it('filters by status', async () => {
        const open = await repo.create(makeNewRound({ status: 'open' }));
        await repo.create(makeNewRound({ status: 'closed', closedAt: minutesLater(60) }));

        expect(ids(await repo.list({ statuses: ['open'] }))).toEqual([open.id]);
      });

      it('returns nothing for an empty status list', async () => {
        await repo.create(makeNewRound());

        expect(await repo.list({ statuses: [] })).toEqual([]);
      });
    });

    describe('findLatest', () => {
      it('returns null from an empty repo', async () => {
        expect(await repo.findLatest()).toBeNull();
      });

      it('returns the round created last, not the one with the latest date', async () => {
        await repo.create(makeNewRound({ date: '2026-12-01', createdAt: minutesLater(0) }));
        const latest = await repo.create(
          makeNewRound({ date: '2026-11-03', createdAt: minutesLater(30) }),
        );
        await repo.create(makeNewRound({ date: '2026-11-20', createdAt: minutesLater(10) }));

        expect(await repo.findLatest()).toEqual(latest);
      });

      it('returns a closed round too', async () => {
        await repo.create(makeNewRound({ createdAt: minutesLater(0) }));
        const closed = await repo.create(
          makeNewRound({
            status: 'closed',
            createdAt: minutesLater(5),
            closedAt: minutesLater(60),
          }),
        );

        expect(await repo.findLatest()).toEqual(closed);
      });

      it('picks the round created last among rounds created at the same moment', async () => {
        await repo.create(makeNewRound());
        await repo.create(makeNewRound());
        const last = await repo.create(makeNewRound());

        expect(await repo.findLatest()).toEqual(last);
      });
    });

    describe('update', () => {
      it('applies the patch and returns the updated round', async () => {
        const created = await repo.create(makeNewRound({ orderIds: orderIds() }));
        const patch: RoundPatch = {
          phase: 'routed',
          stops: [
            { orderId: ORDER_B, hasLocation: true },
            { orderId: ORDER_A, hasLocation: false },
          ],
        };

        const updated = await repo.update(created.id, patch);

        expect(updated).toEqual({ ...created, ...patch });
        expect(await mustFind(created.id)).toEqual(updated);
      });

      it('sets a field the round did not have', async () => {
        const created = await repo.create(makeNewRound());
        const closedAt = minutesLater(90);

        const updated = await repo.update(created.id, { status: 'closed', closedAt });

        expect(updated).toEqual({ ...created, status: 'closed', closedAt });
        expect(await mustFind(created.id)).toEqual(updated);
      });

      it('removes a field whose patch value is undefined', async () => {
        const created = await repo.create(
          makeNewRound({ personalText: 'נאסוף אחרי מנחה', pickupBy: '16:00' }),
        );

        const updated = await repo.update(created.id, { personalText: undefined });
        const found = await mustFind(created.id);

        expect(updated).toEqual(found);
        expect('personalText' in found).toBe(false);
        expect(found.pickupBy).toBe('16:00');
      });

      it('returns the round unchanged for an empty patch', async () => {
        const created = await repo.create(makeNewRound());

        expect(await repo.update(created.id, {})).toEqual(created);
        expect(await mustFind(created.id)).toEqual(created);
      });

      it.each([UNKNOWN_ID, ...MALFORMED_IDS])('returns null for the id %j', async (id) => {
        const created = await repo.create(makeNewRound());

        expect(await repo.update(id, { phase: 'routed' })).toBeNull();
        expect(await mustFind(created.id)).toEqual(created);
      });

      it('changes nothing and returns null when ifStatus does not match', async () => {
        const created = await repo.create(
          makeNewRound({ status: 'closed', closedAt: minutesLater(60) }),
        );

        const result = await repo.update(created.id, { phase: 'routed' }, { ifStatus: ['open'] });

        expect(result).toBeNull();
        expect(await mustFind(created.id)).toEqual(created);
      });

      it('returns null for an empty patch when ifStatus does not match', async () => {
        const created = await repo.create(
          makeNewRound({ status: 'closed', closedAt: minutesLater(60) }),
        );

        expect(await repo.update(created.id, {}, { ifStatus: ['open'] })).toBeNull();
      });

      it('applies the patch when ifStatus matches', async () => {
        const created = await repo.create(makeNewRound());
        const closedAt = minutesLater(60);

        const updated = await repo.update(
          created.id,
          { status: 'closed', closedAt },
          { ifStatus: ['open'] },
        );

        expect(updated?.status).toBe('closed');
        expect(await mustFind(created.id)).toEqual({ ...created, status: 'closed', closedAt });
      });

      it('lets the second of two racing updates find the status already changed', async () => {
        const created = await repo.create(makeNewRound());
        const close = { status: 'closed', closedAt: minutesLater(60) } as const;

        const results = await Promise.all([
          repo.update(created.id, close, { ifStatus: ['open'] }),
          repo.update(created.id, close, { ifStatus: ['open'] }),
        ]);

        expect(results.filter((result) => result !== null)).toHaveLength(1);
      });

      it('changes nothing and returns null when ifPhase does not match', async () => {
        const created = await repo.create(makeNewRound({ phase: 'routed' }));

        const result = await repo.update(
          created.id,
          { stops: [{ orderId: ORDER_A, hasLocation: true }] },
          { ifPhase: ['confirming'] },
        );

        expect(result).toBeNull();
        expect(await mustFind(created.id)).toEqual(created);
      });

      it('returns null for an empty patch when ifPhase does not match', async () => {
        const created = await repo.create(makeNewRound({ phase: 'routed' }));

        expect(await repo.update(created.id, {}, { ifPhase: ['confirming'] })).toBeNull();
      });

      it('returns null for an empty ifPhase list', async () => {
        const created = await repo.create(makeNewRound());

        expect(await repo.update(created.id, { phase: 'routed' }, { ifPhase: [] })).toBeNull();
        expect(await mustFind(created.id)).toEqual(created);
      });

      it('applies the patch when ifPhase matches', async () => {
        const created = await repo.create(makeNewRound({ orderIds: orderIds() }));
        const patch: RoundPatch = {
          phase: 'routed',
          stops: [{ orderId: ORDER_C, hasLocation: true }],
        };

        const updated = await repo.update(created.id, patch, { ifPhase: ['confirming'] });

        expect(updated).toEqual({ ...created, ...patch });
        expect(await mustFind(created.id)).toEqual(updated);
      });

      it('requires both ifStatus and ifPhase to match when both are given', async () => {
        const closedConfirming = await repo.create(
          makeNewRound({ status: 'closed', closedAt: minutesLater(60) }),
        );
        const openRouted = await repo.create(makeNewRound({ phase: 'routed' }));
        const both = { ifStatus: ['open'], ifPhase: ['confirming'] } as const;

        expect(await repo.update(closedConfirming.id, { phase: 'routed' }, both)).toBeNull();
        expect(await repo.update(openRouted.id, { stops: [] }, both)).toBeNull();
        expect(await mustFind(closedConfirming.id)).toEqual(closedConfirming);
        expect(await mustFind(openRouted.id)).toEqual(openRouted);

        const openConfirming = await repo.create(makeNewRound());
        const updated = await repo.update(openConfirming.id, { phase: 'routed' }, both);
        expect(updated).toEqual({ ...openConfirming, phase: 'routed' });
      });

      it('lets the second of two racing updates find the phase already changed', async () => {
        const created = await repo.create(makeNewRound({ orderIds: orderIds() }));
        const build = (orderId: string): RoundPatch => ({
          phase: 'routed',
          stops: [{ orderId, hasLocation: true }],
        });
        const conditions = { ifStatus: ['open'], ifPhase: ['confirming'] } as const;

        const results = await Promise.all([
          repo.update(created.id, build(ORDER_A), conditions),
          repo.update(created.id, build(ORDER_B), conditions),
        ]);

        const winners = results.filter((result) => result !== null);
        expect(winners).toHaveLength(1);
        // The stored route is the winner's, not a mix of the two.
        expect(await mustFind(created.id)).toEqual(winners[0]);
      });
    });

    describe('copies', () => {
      it('hands out copies: changing a returned round does not change the stored one', async () => {
        const created = await repo.create(makeNewRound({ orderIds: orderIds() }));
        const original = structuredClone(created);

        created.orderIds.push('changed');
        created.createdAt.setTime(0);
        const found = await mustFind(created.id);
        found.stops.push({ orderId: 'changed', hasLocation: true });
        const [listed] = await repo.list();
        if (listed !== undefined) listed.status = 'closed';
        const latest = await repo.findLatest();
        if (latest !== null) latest.orderIds.length = 0;
        const updated = await repo.update(created.id, {});
        if (updated !== null) updated.region = 'old';

        expect(await mustFind(created.id)).toEqual(original);
      });

      it('keeps its own copy of what it was given', async () => {
        const input = makeNewRound({ orderIds: orderIds() });
        const created = await repo.create(input);
        const stops: RoundStop[] = [{ orderId: ORDER_A, hasLocation: true }];
        const closedAt = minutesLater(60);
        await repo.update(created.id, { stops, closedAt });

        input.orderIds.push('changed');
        input.createdAt.setTime(0);
        stops.push({ orderId: 'changed', hasLocation: true });
        closedAt.setTime(0);

        expect(await mustFind(created.id)).toEqual({
          ...created,
          stops: [{ orderId: ORDER_A, hasLocation: true }],
          closedAt: minutesLater(60),
        });
      });
    });
  });
}
