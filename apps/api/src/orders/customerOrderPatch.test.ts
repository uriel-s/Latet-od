// buildCustomerOrderPatch: the rules of the customer's "שינוי" (spec §3.3, ADR-0005) on real
// streets from data/streets.json. Every request goes through the shared
// customerUpdateOrderRequestSchema first, as the route sends it, so a change in the schema's
// output that breaks a rule shows up here.
import { describe, expect, it } from 'vitest';
import {
  STREETS,
  customerUpdateOrderRequestSchema,
  type CustomerUpdateOrder,
  type CustomerUpdateOrderRequest,
  type MessageLogEntry,
  type Order,
  type Round,
  type Street,
} from '@bottlerun/shared';
import { makeNewRound } from '../rounds/makeRound.ts';
import { buildCustomerOrderPatch } from './customerOrderPatch.ts';
import { InMemoryOrdersRepo } from './inMemoryOrdersRepo.ts';
import { makeNewOrder } from './makeOrder.ts';

const NOW = new Date('2026-11-11T18:45:00.000Z');
const ORDER_ID = '6710f3a2c4b5d6e7f8a9b0c1';
const ROUND_ID = '6650a1b2c3d4e5f6a7b8c9d0';
const EARLIER_ROUND_ID = '6650a1b2c3d4e5f6a7b8c9d1';

const ROUND: Round = { ...makeNewRound({ date: '2026-11-12' }), id: ROUND_ID };

/** The first street of the real list that matches, or a failed test if there is none. */
function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}

const RAMAT_STREET = firstRealStreet((street) => street.region === 'ramat');
const OLD_STREET = firstRealStreet((street) => street.region === 'old');
// A listed street the geocoding gave no region. The list has some today; once every street has
// a region, the case it covers no longer exists and its test is skipped.
const STREET_WITHOUT_REGION = STREETS.find((street) => street.region === undefined);

const CONFIRM_REQUEST: MessageLogEntry = {
  kind: 'confirmRequest',
  at: new Date('2026-11-10T09:00:00.000Z'),
  mode: 'manual',
  url: 'https://wa.me/972500000000?text=confirm',
};

/** A free-text street ("הרחוב שלי לא ברשימה") with Yoel's near street in רמת בית שמש. */
const FREE_TEXT_WITH_NEAR: Order['address'] = {
  streetName: 'הרחוב שלי',
  nearStreetCode: RAMAT_STREET.code,
  houseNumber: '12',
  bottlesSpot: 'privateHouse',
};

/** An address on a listed street, as stored: the code and its official name. */
function listedAddress(street: Street): Order['address'] {
  return {
    streetCode: street.code,
    streetName: street.name,
    houseNumber: '7',
    bottlesSpot: 'apartmentDoor',
    floorApt: 'קומה 2, דירה 5',
    note: 'דלת חומה',
  };
}

/** A stored `waiting` order in no round (a free-text street, no region unless overridden). */
function storedOrder(overrides: Partial<Order> = {}): Order {
  return { ...makeNewOrder(), id: ORDER_ID, ...overrides };
}

/** A stored order `pending` in {@link ROUND}, with its confirmation request in the log. */
function orderInRound(overrides: Partial<Order> = {}): Order {
  return storedOrder({
    status: 'pending',
    roundId: ROUND_ID,
    messages: [CONFIRM_REQUEST],
    ...overrides,
  });
}

/** The request as the route gets it: validated by the shared schema. */
function parseRequest(body: CustomerUpdateOrderRequest): CustomerUpdateOrder {
  return customerUpdateOrderRequestSchema.parse(body);
}

/** The request address that keeps the free-text address of {@link FREE_TEXT_WITH_NEAR}. */
const SAME_FREE_TEXT_INPUT = {
  streetName: 'הרחוב שלי',
  houseNumber: '12',
  bottlesSpot: 'privateHouse',
} as const;

describe('buildCustomerOrderPatch: bottles and the note', () => {
  it('replaces the number of bottles (sent as text) and nothing else', () => {
    const stored = orderInRound({ region: 'ramat' });

    const { patch, leftRound } = buildCustomerOrderPatch(
      stored,
      parseRequest({ bottlesEstimated: '45' }),
      ROUND,
      NOW,
    );

    expect(patch).toStrictEqual({ bottlesEstimated: 45, updatedAt: NOW });
    expect(leftRound).toBe(false);
  });

  it('always sets updatedAt to a copy of now', () => {
    const { patch } = buildCustomerOrderPatch(
      storedOrder(),
      parseRequest({ bottlesEstimated: 40 }),
      null,
      NOW,
    );

    expect(patch.updatedAt).toEqual(NOW);
    expect(patch.updatedAt).not.toBe(NOW);
  });

  it('keeps a pending order in its round when only the note changes, near street and region too', () => {
    const stored = orderInRound({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    const { patch, leftRound } = buildCustomerOrderPatch(
      stored,
      parseRequest({ address: { ...SAME_FREE_TEXT_INPUT, note: '  ליד העגלה  ' } }),
      ROUND,
      NOW,
    );

    expect(patch).toStrictEqual({
      address: { ...FREE_TEXT_WITH_NEAR, note: 'ליד העגלה' },
      updatedAt: NOW,
    });
    expect(leftRound).toBe(false);
  });

  it('keeps a confirmed order in its round when only where the bottles wait changes', () => {
    const stored = orderInRound({
      status: 'confirmed',
      address: listedAddress(OLD_STREET),
      region: 'old',
    });

    const { patch, leftRound } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: { streetCode: OLD_STREET.code, houseNumber: '7', bottlesSpot: 'buildingEntrance' },
      }),
      ROUND,
      NOW,
    );

    // The address is replaced as a whole: the floor, apartment and note sent no more are gone.
    expect(patch).toStrictEqual({
      address: {
        streetCode: OLD_STREET.code,
        streetName: OLD_STREET.name,
        houseNumber: '7',
        bottlesSpot: 'buildingEntrance',
      },
      updatedAt: NOW,
    });
    expect(leftRound).toBe(false);
  });
});

describe('buildCustomerOrderPatch: the near street and the region', () => {
  it('a new house number keeps the near street and the region, and takes the order out of its round', () => {
    const stored = orderInRound({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    const { patch, leftRound } = buildCustomerOrderPatch(
      stored,
      parseRequest({ address: { ...SAME_FREE_TEXT_INPUT, houseNumber: '14' } }),
      ROUND,
      NOW,
    );

    expect(patch.address).toStrictEqual({ ...FREE_TEXT_WITH_NEAR, houseNumber: '14' });
    expect(patch).not.toHaveProperty('region');
    expect(leftRound).toBe(true);
    expect(patch.status).toBe('waiting');
  });

  it('keeps a region Yoel set by hand when only the house number changes', () => {
    // A listed street of רמת בית שמש that Yoel moved to the old city by hand.
    const stored = storedOrder({ address: listedAddress(RAMAT_STREET), region: 'old' });

    const { patch } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: { streetCode: RAMAT_STREET.code, houseNumber: '9', bottlesSpot: 'privateHouse' },
      }),
      null,
      NOW,
    );

    expect(patch).not.toHaveProperty('region');
  });

  it('a new listed street drops the near street and derives the region from the new street', () => {
    const stored = storedOrder({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    const { patch } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: { streetCode: OLD_STREET.code, houseNumber: '12', bottlesSpot: 'privateHouse' },
      }),
      null,
      NOW,
    );

    expect(patch).toStrictEqual({
      address: {
        streetCode: OLD_STREET.code,
        streetName: OLD_STREET.name,
        houseNumber: '12',
        bottlesSpot: 'privateHouse',
      },
      region: 'old',
      updatedAt: NOW,
    });
  });

  it('a new listed street in the same region leaves the region out of the patch', () => {
    const stored = storedOrder({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    const { patch } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: { streetCode: RAMAT_STREET.code, houseNumber: '12', bottlesSpot: 'privateHouse' },
      }),
      null,
      NOW,
    );

    expect(patch).not.toHaveProperty('region');
    expect(patch.address).not.toHaveProperty('nearStreetCode');
  });

  it('a move to a free-text street removes the region ("בלי אזור"), with the key set to undefined', () => {
    const stored = storedOrder({ address: listedAddress(RAMAT_STREET), region: 'ramat' });

    const { patch } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: { streetName: 'רחוב חדש', houseNumber: '7', bottlesSpot: 'privateHouse' },
      }),
      null,
      NOW,
    );

    expect(Object.keys(patch)).toContain('region');
    expect(patch.region).toBeUndefined();
    expect(patch.address).toStrictEqual({
      streetName: 'רחוב חדש',
      houseNumber: '7',
      bottlesSpot: 'privateHouse',
    });
  });

  it('a fixed free-text street name drops the near street Yoel picked for the old name', () => {
    const stored = storedOrder({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    const { patch } = buildCustomerOrderPatch(
      stored,
      parseRequest({ address: { ...SAME_FREE_TEXT_INPUT, streetName: 'הרחוב שלי המתוקן' } }),
      null,
      NOW,
    );

    expect(patch.address).not.toHaveProperty('nearStreetCode');
    expect(Object.keys(patch)).toContain('region');
    expect(patch.region).toBeUndefined();
  });

  it('a new free-text street of an order with no region puts no region key in the patch', () => {
    const stored = storedOrder();
    expect(stored).not.toHaveProperty('region');

    const { patch } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: { streetName: 'רחוב אחר', houseNumber: '3', bottlesSpot: 'privateHouse' },
      }),
      null,
      NOW,
    );

    expect(patch).not.toHaveProperty('region');
  });

  it.skipIf(STREET_WITHOUT_REGION === undefined)(
    'a move to a listed street with no region removes the region too',
    () => {
      // Narrows the type only: skipIf above already skips the test when there is no such street.
      if (STREET_WITHOUT_REGION === undefined) return;
      const stored = storedOrder({ address: listedAddress(OLD_STREET), region: 'old' });

      const { patch } = buildCustomerOrderPatch(
        stored,
        parseRequest({
          address: {
            streetCode: STREET_WITHOUT_REGION.code,
            houseNumber: '7',
            bottlesSpot: 'privateHouse',
          },
        }),
        null,
        NOW,
      );

      expect(Object.keys(patch)).toContain('region');
      expect(patch.region).toBeUndefined();
    },
  );
});

describe('buildCustomerOrderPatch: leaving the round', () => {
  it.each(['pending', 'confirmed'] as const)(
    'takes a %s order out of its round on a new street: waiting, no roundId, lastMiss addressChanged',
    (status) => {
      const stored = orderInRound({
        status,
        address: listedAddress(RAMAT_STREET),
        region: 'ramat',
      });

      const { patch, leftRound } = buildCustomerOrderPatch(
        stored,
        parseRequest({
          address: { streetCode: OLD_STREET.code, houseNumber: '7', bottlesSpot: 'privateHouse' },
        }),
        ROUND,
        NOW,
      );

      expect(leftRound).toBe(true);
      expect(patch).toStrictEqual({
        address: {
          streetCode: OLD_STREET.code,
          streetName: OLD_STREET.name,
          houseNumber: '7',
          bottlesSpot: 'privateHouse',
        },
        region: 'old',
        status: 'waiting',
        roundId: undefined,
        lastMiss: { date: ROUND.date, reason: 'addressChanged', roundId: ROUND_ID },
        updatedAt: NOW,
      });
    },
  );

  it('takes the order out without a lastMiss when its round is missing, keeping an earlier one', () => {
    const earlierMiss = {
      date: '2026-10-01',
      reason: 'notFound',
      roundId: EARLIER_ROUND_ID,
    } as const;
    const stored = orderInRound({ address: FREE_TEXT_WITH_NEAR, lastMiss: earlierMiss });

    const { patch, leftRound } = buildCustomerOrderPatch(
      stored,
      parseRequest({ address: { ...SAME_FREE_TEXT_INPUT, houseNumber: '13' } }),
      null,
      NOW,
    );

    expect(leftRound).toBe(true);
    expect(patch.status).toBe('waiting');
    expect(Object.keys(patch)).toContain('roundId');
    expect(patch.roundId).toBeUndefined();
    expect(patch).not.toHaveProperty('lastMiss');
  });

  it('never gives a waiting order a lastMiss or another status: it is in no round', () => {
    const stored = storedOrder({ address: listedAddress(RAMAT_STREET), region: 'ramat' });

    const { patch, leftRound } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: { streetCode: OLD_STREET.code, houseNumber: '8', bottlesSpot: 'privateHouse' },
      }),
      ROUND,
      NOW,
    );

    expect(leftRound).toBe(false);
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('roundId');
    expect(patch).not.toHaveProperty('lastMiss');
    expect(patch.region).toBe('old');
  });

  it('keeps the order in its round when the same address is sent again', () => {
    const stored = orderInRound({ address: listedAddress(OLD_STREET), region: 'old' });

    const { patch, leftRound } = buildCustomerOrderPatch(
      stored,
      parseRequest({
        address: {
          streetCode: OLD_STREET.code,
          houseNumber: '7',
          bottlesSpot: 'apartmentDoor',
          floorApt: 'קומה 2, דירה 5',
          note: 'דלת חומה',
        },
        bottlesEstimated: 60,
      }),
      ROUND,
      NOW,
    );

    expect(leftRound).toBe(false);
    expect(patch).toStrictEqual({
      address: listedAddress(OLD_STREET),
      bottlesEstimated: 60,
      updatedAt: NOW,
    });
  });
});

describe('buildCustomerOrderPatch: the patch', () => {
  const requests: { label: string; body: CustomerUpdateOrderRequest }[] = [
    { label: 'bottles', body: { bottlesEstimated: 31 } },
    { label: 'note', body: { address: { ...SAME_FREE_TEXT_INPUT, note: 'הערה' } } },
    { label: 'house number', body: { address: { ...SAME_FREE_TEXT_INPUT, houseNumber: '1' } } },
    {
      label: 'listed street',
      body: {
        address: { streetCode: OLD_STREET.code, houseNumber: '2', bottlesSpot: 'privateHouse' },
      },
    },
    {
      label: 'free-text street with empty optional fields',
      body: {
        address: {
          streetName: 'רחוב',
          houseNumber: '1',
          bottlesSpot: 'privateHouse',
          floorApt: '',
          note: '  ',
        },
      },
    },
    {
      label: 'address and bottles',
      body: {
        address: { streetCode: RAMAT_STREET.code, houseNumber: '2', bottlesSpot: 'privateHouse' },
        bottlesEstimated: '50',
      },
    },
  ];

  it.each(requests)('never holds contact, messages, token or source: $label', ({ body }) => {
    const stored = orderInRound({ address: FREE_TEXT_WITH_NEAR, region: 'ramat' });

    const { patch } = buildCustomerOrderPatch(stored, parseRequest(body), ROUND, NOW);

    for (const key of ['contact', 'messages', 'token', 'source', 'createdAt', 'id']) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it.each(requests)(
    'gives an order the repo stores and orderSchema reads: $label',
    async ({ body }) => {
      const repo = new InMemoryOrdersRepo();
      const stored = await repo.create(
        makeNewOrder({
          status: 'pending',
          roundId: ROUND_ID,
          messages: [CONFIRM_REQUEST],
          address: FREE_TEXT_WITH_NEAR,
          region: 'ramat',
        }),
      );

      const { patch } = buildCustomerOrderPatch(stored, parseRequest(body), ROUND, NOW);
      const updated = await repo.update(stored.id, patch, { ifStatus: [stored.status] });

      expect(updated).not.toBeNull();
      expect(updated?.messages).toStrictEqual([CONFIRM_REQUEST]);
      expect(updated?.contact).toStrictEqual(stored.contact);
    },
  );

  it('throws, without customer data in the message, when the patched order would not be valid', () => {
    // A request that skipped validation: a bug in the caller, which must not reach the database.
    const unvalidated = {
      address: { streetName: 'רחוב סודי', houseNumber: '', bottlesSpot: 'privateHouse' },
    } as CustomerUpdateOrder;

    expect(() => buildCustomerOrderPatch(storedOrder(), unvalidated, null, NOW)).toThrow(
      'buildCustomerOrderPatch: the patched order does not match orderSchema',
    );
  });
});
