// The behaviour every OrdersRepo must have, as a reusable Vitest suite. The in-memory fake runs
// it in inMemoryOrdersRepo.test.ts; the Mongo repo runs the same suite, so the fake the other
// tests rely on is proven to behave like the real database. Deliberately not named *.test.ts:
// it only declares tests when an implementation calls it.
import { beforeEach, describe, expect, it } from 'vitest';
import { orderSchema, type MessageLogEntry, type NewOrder, type Order } from '@bottlerun/shared';
import { makeNewOrder, MADE_ORDER_CREATED_AT } from './makeOrder.ts';
import { DuplicateOpenOrderError, type OrdersRepo } from './ordersRepo.ts';

/** Well-formed (ObjectId-shaped) but never handed out by a fresh repo in practice. */
const UNKNOWN_ID = '0123456789abcdef01234567';

/** Ids no implementation can have issued: they must give null, not an error. */
const MALFORMED_IDS = ['nope', '../x', '', '0123456789abcdef012345678'];

/** `MADE_ORDER_CREATED_AT` plus `minutes`. */
function minutesLater(minutes: number): Date {
  return new Date(MADE_ORDER_CREATED_AT.getTime() + minutes * 60_000);
}

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  return expect.fail('expected the promise to reject');
}

/**
 * Declares the OrdersRepo contract tests for one implementation.
 *
 * @param name Shown in the test names, e.g. 'InMemoryOrdersRepo'.
 * @param makeRepo Called before every test; must return an EMPTY repo (for a real database:
 *   a fresh or emptied collection), since the tests count and list everything in it.
 */
export function describeOrdersRepoContract(
  name: string,
  makeRepo: () => OrdersRepo | Promise<OrdersRepo>,
): void {
  describe(`OrdersRepo contract: ${name}`, () => {
    let repo: OrdersRepo;

    beforeEach(async () => {
      repo = await makeRepo();
    });

    /** A fresh order of the same customer as `order`: same phone, everything else new. */
    function samePhoneAs(order: NewOrder, overrides: Partial<NewOrder> = {}): NewOrder {
      return makeNewOrder({ ...overrides, contact: { ...order.contact } });
    }

    /** The stored order with this id; fails the test if there is none. */
    async function mustFind(id: string): Promise<Order> {
      const order = await repo.findById(id);
      if (order === null) return expect.fail(`order ${id} not found`);
      return order;
    }

    /** Ids of `orders`, to compare lists by identity and order. */
    function ids(orders: readonly Order[]): string[] {
      return orders.map((order) => order.id);
    }

    describe('create', () => {
      it('returns the order with a new id, in the stored order shape', async () => {
        const input = makeNewOrder();

        const created = await repo.create(input);

        expect(created.id).not.toBe('');
        expect(created).toEqual({ ...input, id: created.id });
        // orderSchema strips unknown keys (such as Mongo's _id): nothing may be lost to it.
        expect(orderSchema.parse(created)).toEqual(created);
        expect(created.createdAt).toBeInstanceOf(Date);
      });

      it('gives every order its own id', async () => {
        const first = await repo.create(makeNewOrder());
        const second = await repo.create(makeNewOrder());

        expect(second.id).not.toBe(first.id);
      });

      it('makes the order findable by id and by token', async () => {
        const created = await repo.create(makeNewOrder());

        expect(await repo.findById(created.id)).toEqual(created);
        expect(await repo.findByToken(created.token)).toEqual(created);
      });

      it('leaves out fields whose value is undefined, also nested ones', async () => {
        const input = makeNewOrder({ region: undefined, roundId: undefined });
        input.address.note = undefined;

        const created = await repo.create(input);
        const found = await mustFind(created.id);

        for (const order of [created, found]) {
          expect('region' in order).toBe(false);
          expect('roundId' in order).toBe(false);
          expect('note' in order.address).toBe(false);
        }
      });

      it('rejects a second open order for the same phone, without the phone in the error', async () => {
        const first = await repo.create(makeNewOrder());

        const error = await rejectionOf(repo.create(samePhoneAs(first)));

        expect(error).toBeInstanceOf(DuplicateOpenOrderError);
        expect(error.name).toBe('DuplicateOpenOrderError');
        // The last 8 digits are in every way of writing the number (+9725…, 05…).
        expect(error.message).not.toContain(first.contact.phone.slice(-8));
        expect(ids(await repo.list())).toEqual([first.id]);
      });

      it.each(['collected', 'cancelled'] as const)(
        'accepts a new order once the previous one is %s',
        async (status) => {
          const first = await repo.create(makeNewOrder());
          await repo.update(first.id, { status });

          const second = await repo.create(samePhoneAs(first));

          expect(await repo.findOpenByPhone(first.contact.phone)).toEqual(second);
        },
      );

      it('stores a closed order for a phone that has an open one', async () => {
        const open = await repo.create(makeNewOrder());

        const closed = await repo.create(samePhoneAs(open, { status: 'collected' }));

        expect(await mustFind(closed.id)).toEqual(closed);
      });

      it('rejects a token that is already taken, as a different error', async () => {
        const first = await repo.create(makeNewOrder());

        const error = await rejectionOf(repo.create(makeNewOrder({ token: first.token })));

        // Not the customer's duplicate: the api must not answer it with "you already ordered".
        expect(error).not.toBeInstanceOf(DuplicateOpenOrderError);
        expect(await repo.list()).toHaveLength(1);
      });
    });

    describe('findById and findByToken', () => {
      it('return null for an unknown id or token', async () => {
        await repo.create(makeNewOrder());

        expect(await repo.findById(UNKNOWN_ID)).toBeNull();
        expect(await repo.findByToken(makeNewOrder().token)).toBeNull();
      });

      it.each(MALFORMED_IDS)('return null for the malformed id %j', async (id) => {
        await repo.create(makeNewOrder());

        expect(await repo.findById(id)).toBeNull();
      });
    });

    describe('findOpenByPhone', () => {
      it('returns the open order of the phone, not its closed ones or other phones', async () => {
        const cancelled = await repo.create(makeNewOrder({ status: 'cancelled' }));
        const open = await repo.create(samePhoneAs(cancelled, { status: 'confirmed' }));
        await repo.create(makeNewOrder());

        expect(await repo.findOpenByPhone(open.contact.phone)).toEqual(open);
      });

      it('returns null when the phone has only closed orders', async () => {
        const collected = await repo.create(makeNewOrder({ status: 'collected' }));
        await repo.create(samePhoneAs(collected, { status: 'cancelled' }));

        expect(await repo.findOpenByPhone(collected.contact.phone)).toBeNull();
      });

      it('returns null for a phone with no orders', async () => {
        await repo.create(makeNewOrder());

        expect(await repo.findOpenByPhone(makeNewOrder().contact.phone)).toBeNull();
      });
    });

    describe('list', () => {
      it('returns every order, oldest first', async () => {
        const newest = await repo.create(makeNewOrder({ createdAt: minutesLater(20) }));
        const oldest = await repo.create(makeNewOrder({ createdAt: minutesLater(0) }));
        const middle = await repo.create(makeNewOrder({ createdAt: minutesLater(10) }));

        expect(ids(await repo.list())).toEqual([oldest.id, middle.id, newest.id]);
      });

      it('keeps creation order for orders created at the same moment', async () => {
        const first = await repo.create(makeNewOrder());
        const second = await repo.create(makeNewOrder());
        const third = await repo.create(makeNewOrder());

        expect(ids(await repo.list())).toEqual([first.id, second.id, third.id]);
      });

      it('returns nothing from an empty repo', async () => {
        expect(await repo.list()).toEqual([]);
      });

      it('filters by status', async () => {
        const waiting = await repo.create(makeNewOrder({ status: 'waiting' }));
        const pending = await repo.create(makeNewOrder({ status: 'pending' }));
        await repo.create(makeNewOrder({ status: 'collected' }));
        await repo.create(makeNewOrder({ status: 'cancelled' }));

        const open = await repo.list({ statuses: ['pending', 'waiting'] });

        expect(ids(open)).toEqual([waiting.id, pending.id]);
      });

      it('returns nothing for an empty status list', async () => {
        await repo.create(makeNewOrder());

        expect(await repo.list({ statuses: [] })).toEqual([]);
      });

      it('filters by round', async () => {
        const inRound = await repo.create(makeNewOrder({ status: 'pending', roundId: 'round-1' }));
        await repo.create(makeNewOrder({ status: 'pending', roundId: 'round-2' }));
        await repo.create(makeNewOrder());

        expect(ids(await repo.list({ roundId: 'round-1' }))).toEqual([inRound.id]);
      });

      it('applies status and round together', async () => {
        const confirmed = await repo.create(
          makeNewOrder({ status: 'confirmed', roundId: 'round-1' }),
        );
        await repo.create(makeNewOrder({ status: 'collected', roundId: 'round-1' }));
        await repo.create(makeNewOrder({ status: 'confirmed', roundId: 'round-2' }));

        const result = await repo.list({ statuses: ['confirmed'], roundId: 'round-1' });

        expect(ids(result)).toEqual([confirmed.id]);
      });

      it('filters by ids, oldest first whatever the order of the list', async () => {
        const older = await repo.create(makeNewOrder({ createdAt: minutesLater(0) }));
        await repo.create(makeNewOrder({ createdAt: minutesLater(5) }));
        const newer = await repo.create(makeNewOrder({ createdAt: minutesLater(10) }));

        const result = await repo.list({ ids: [newer.id, older.id] });

        expect(ids(result)).toEqual([older.id, newer.id]);
      });

      it('skips unknown and malformed ids in the ids filter', async () => {
        const created = await repo.create(makeNewOrder());

        const result = await repo.list({ ids: [UNKNOWN_ID, ...MALFORMED_IDS, created.id] });

        expect(ids(result)).toEqual([created.id]);
      });

      it('returns nothing when no id in the ids filter is known', async () => {
        await repo.create(makeNewOrder());

        expect(await repo.list({ ids: [UNKNOWN_ID] })).toEqual([]);
        expect(await repo.list({ ids: MALFORMED_IDS })).toEqual([]);
      });

      it('returns nothing for an empty ids list', async () => {
        await repo.create(makeNewOrder());

        expect(await repo.list({ ids: [] })).toEqual([]);
      });

      it('applies ids and status together', async () => {
        const pending = await repo.create(makeNewOrder({ status: 'pending' }));
        const cancelled = await repo.create(makeNewOrder({ status: 'cancelled' }));
        await repo.create(makeNewOrder({ status: 'pending' }));

        const result = await repo.list({ ids: [pending.id, cancelled.id], statuses: ['pending'] });

        expect(ids(result)).toEqual([pending.id]);
      });

      describe('closedBetween', () => {
        // A one-hour window, starting 60 minutes after the made orders' createdAt.
        const range = { from: minutesLater(60), to: minutesLater(120) };

        /** A collected order, collected at `collectedAt`. */
        function collectedAt(collectedAt: Date, overrides: Partial<NewOrder> = {}): NewOrder {
          return makeNewOrder({
            status: 'collected',
            collectedAt,
            bottlesCollected: 50,
            ...overrides,
          });
        }

        /** A cancelled order, cancelled at `cancelledAt`. */
        function cancelledAt(cancelledAt: Date, overrides: Partial<NewOrder> = {}): NewOrder {
          return makeNewOrder({ status: 'cancelled', cancelledAt, ...overrides });
        }

        it('returns collected and cancelled orders closed in the range, oldest first', async () => {
          const cancelled = await repo.create(
            cancelledAt(minutesLater(70), { createdAt: minutesLater(0) }),
          );
          const collected = await repo.create(
            collectedAt(minutesLater(90), { createdAt: minutesLater(-10) }),
          );
          await repo.create(collectedAt(minutesLater(30)));
          await repo.create(cancelledAt(minutesLater(150)));

          const result = await repo.list({ closedBetween: range });

          expect(ids(result)).toEqual([collected.id, cancelled.id]);
        });

        it('leaves out open orders, even with a close timestamp in the range', async () => {
          await repo.create(makeNewOrder({ status: 'waiting' }));
          await repo.create(makeNewOrder({ status: 'pending', collectedAt: minutesLater(90) }));
          await repo.create(makeNewOrder({ status: 'confirmed', cancelledAt: minutesLater(90) }));

          expect(await repo.list({ closedBetween: range })).toEqual([]);
        });

        it('includes an order closed exactly at from and excludes one closed exactly at to', async () => {
          const atFrom = await repo.create(collectedAt(range.from));
          await repo.create(collectedAt(range.to));
          const cancelledAtFrom = await repo.create(cancelledAt(range.from));
          await repo.create(cancelledAt(range.to));

          const result = await repo.list({ closedBetween: range });

          expect(ids(result)).toEqual([atFrom.id, cancelledAtFrom.id]);
        });

        it("goes by each status's own timestamp, not the other one", async () => {
          // Collected outside the range: a cancelledAt in range (from an earlier cancel and
          // reopen, say) does not bring it in. Likewise for a cancelled order's collectedAt.
          await repo.create(collectedAt(minutesLater(30), { cancelledAt: minutesLater(90) }));
          await repo.create(cancelledAt(minutesLater(30), { collectedAt: minutesLater(90) }));
          // A closed order without its own timestamp has no close time, so no range has it.
          await repo.create(makeNewOrder({ status: 'collected', cancelledAt: minutesLater(90) }));
          const inRange = await repo.create(
            collectedAt(minutesLater(90), { cancelledAt: minutesLater(30) }),
          );

          expect(ids(await repo.list({ closedBetween: range }))).toEqual([inRange.id]);
        });

        it('applies closedBetween and statuses together', async () => {
          const collected = await repo.create(collectedAt(minutesLater(80)));
          await repo.create(cancelledAt(minutesLater(80)));
          await repo.create(collectedAt(minutesLater(10)));

          const result = await repo.list({ statuses: ['collected'], closedBetween: range });

          expect(ids(result)).toEqual([collected.id]);
        });
      });
    });

    describe('update', () => {
      it('applies the patch and returns the updated order', async () => {
        const created = await repo.create(makeNewOrder());
        const patch = {
          status: 'pending',
          roundId: 'round-1',
          updatedAt: minutesLater(5),
        } as const;

        const updated = await repo.update(created.id, patch);

        expect(updated).toEqual({ ...created, ...patch });
        expect(await mustFind(created.id)).toEqual(updated);
      });

      it('replaces a nested object as a whole', async () => {
        const created = await repo.create(
          makeNewOrder({
            address: {
              streetName: 'הרחוב שלי',
              houseNumber: '12',
              bottlesSpot: 'apartmentDoor',
              floorApt: 'קומה 3, דירה 12',
              note: 'קוד לבניין 1234',
            },
          }),
        );
        const address = {
          streetName: 'הרחוב שלי',
          houseNumber: '14',
          bottlesSpot: 'privateHouse',
        } as const;

        await repo.update(created.id, { address });

        expect((await mustFind(created.id)).address).toEqual(address);
      });

      it('removes a field whose patch value is undefined', async () => {
        const created = await repo.create(makeNewOrder({ status: 'pending', roundId: 'round-1' }));

        const updated = await repo.update(created.id, { status: 'waiting', roundId: undefined });
        const found = await mustFind(created.id);

        expect(updated).toEqual(found);
        expect(found.status).toBe('waiting');
        expect('roundId' in found).toBe(false);
      });

      it('returns the order unchanged for an empty patch', async () => {
        const created = await repo.create(makeNewOrder());

        expect(await repo.update(created.id, {})).toEqual(created);
        expect(await mustFind(created.id)).toEqual(created);
      });

      it.each([UNKNOWN_ID, ...MALFORMED_IDS])('returns null for the id %j', async (id) => {
        const created = await repo.create(makeNewOrder());

        expect(await repo.update(id, { bottlesEstimated: 99 })).toBeNull();
        expect(await mustFind(created.id)).toEqual(created);
      });

      it('changes nothing and returns null when ifStatus does not match', async () => {
        const created = await repo.create(makeNewOrder({ status: 'collected' }));

        const result = await repo.update(
          created.id,
          { status: 'cancelled' },
          { ifStatus: ['waiting', 'pending', 'confirmed'] },
        );

        expect(result).toBeNull();
        expect(await mustFind(created.id)).toEqual(created);
      });

      it('applies the patch when ifStatus matches', async () => {
        const created = await repo.create(makeNewOrder({ status: 'pending' }));

        const updated = await repo.update(
          created.id,
          { status: 'confirmed' },
          { ifStatus: ['pending'] },
        );

        expect(updated?.status).toBe('confirmed');
        expect((await mustFind(created.id)).status).toBe('confirmed');
      });

      it('lets the second of two racing updates find the status already changed', async () => {
        const created = await repo.create(makeNewOrder({ status: 'pending' }));
        const confirm = { status: 'confirmed' } as const;

        const results = await Promise.all([
          repo.update(created.id, confirm, { ifStatus: ['pending'] }),
          repo.update(created.id, confirm, { ifStatus: ['pending'] }),
        ]);

        expect(results.filter((result) => result !== null)).toHaveLength(1);
      });

      it('rejects reopening an order while its phone has another open order', async () => {
        const cancelled = await repo.create(makeNewOrder({ status: 'cancelled' }));
        await repo.create(samePhoneAs(cancelled));

        const error = await rejectionOf(repo.update(cancelled.id, { status: 'waiting' }));

        expect(error).toBeInstanceOf(DuplicateOpenOrderError);
        expect(await mustFind(cancelled.id)).toEqual(cancelled);
      });

      it('rejects moving an open order onto a phone that has an open order', async () => {
        const other = await repo.create(makeNewOrder());
        const moved = await repo.create(makeNewOrder());

        const error = await rejectionOf(
          repo.update(moved.id, { contact: { ...moved.contact, phone: other.contact.phone } }),
        );

        expect(error).toBeInstanceOf(DuplicateOpenOrderError);
        expect(await mustFind(moved.id)).toEqual(moved);
      });
    });

    describe('copies', () => {
      it('hands out copies: changing a returned order does not change the stored one', async () => {
        const created = await repo.create(makeNewOrder());
        const original = structuredClone(created);
        const message: MessageLogEntry = {
          kind: 'thankYou',
          at: minutesLater(1),
          mode: 'failed',
          reason: 'test',
        };

        created.contact.name = 'changed';
        created.messages.push(message);
        created.createdAt.setTime(0);
        const found = await mustFind(created.id);
        found.address.houseNumber = '99';
        const [listed] = await repo.list();
        if (listed !== undefined) listed.status = 'cancelled';

        expect(await mustFind(created.id)).toEqual(original);
        expect(await repo.findByToken(original.token)).toEqual(original);
      });

      it('keeps its own copy of what it was given', async () => {
        const input = makeNewOrder();
        const created = await repo.create(input);
        const original = structuredClone(created);
        const address = { ...created.address, houseNumber: '14' };
        await repo.update(created.id, { address });

        input.contact.name = 'changed';
        input.updatedAt.setTime(0);
        address.houseNumber = '99';

        expect(await mustFind(created.id)).toEqual({
          ...original,
          address: { ...original.address, houseNumber: '14' },
        });
      });
    });
  });
}
