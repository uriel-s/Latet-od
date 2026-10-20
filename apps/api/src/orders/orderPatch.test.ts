// buildOrderPatch: the rules of Yoel's PATCH (updateOrderRequestSchema's JSDoc, spec §3.5,
// ADR-0005) on real streets from data/streets.json. Every request goes through the shared
// updateOrderRequestSchema first, as the route sends it, so a change in the schema's output that
// breaks a rule shows up here.
import { describe, expect, it } from 'vitest';
import {
  STREETS,
  updateOrderRequestSchema,
  type Order,
  type Street,
  type UpdateOrder,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import { InMemoryOrdersRepo } from './inMemoryOrdersRepo.ts';
import { makeNewOrder } from './makeOrder.ts';
import { buildOrderPatch } from './orderPatch.ts';

const NOW = new Date('2026-10-20T10:15:00.000Z');
const ORDER_ID = '6710f3a2c4b5d6e7f8a9b0c1';

/** The first street of the real list that matches, or a failed test if there is none. */
function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}

const RAMAT_STREET = firstRealStreet((street) => street.region === 'ramat');
const OLD_STREET = firstRealStreet((street) => street.region === 'old');
// A listed street the geocoding gave no region. The list has some today; once every street has
// a region, the case it covers no longer exists and its tests are skipped.
const STREET_WITHOUT_REGION = STREETS.find((street) => street.region === undefined);

/** A free-text street ("הרחוב שלי לא ברשימה"): no code, so no region and no point. */
const FREE_TEXT_ADDRESS: Order['address'] = {
  streetName: 'הרחוב שלי',
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

/** A stored order (a free-text street, no region unless overridden), with an id. */
function storedOrder(overrides: Partial<Order> = {}): Order {
  return { ...makeNewOrder(), id: ORDER_ID, ...overrides };
}

/** The request as the route gets it: validated by the shared schema. */
function parseRequest(body: UpdateOrderRequest): UpdateOrder {
  return updateOrderRequestSchema.parse(body);
}

/** Fails the test if any value in `value`, at any depth, is `undefined`. */
function expectNoUndefined(value: unknown, path = 'patch'): void {
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  for (const [key, field] of Object.entries(value)) {
    expect(field, `${path}.${key}`).not.toBeUndefined();
    expectNoUndefined(field, `${path}.${key}`);
  }
}

describe('buildOrderPatch: contact and bottles', () => {
  it('replaces name and phone (in E.164) and keeps the stored contact method', () => {
    const stored = storedOrder();

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({ contact: { name: '  רחל לוי ', phone: '052-7654321' } }),
      NOW,
    );

    expect(patch).toStrictEqual({
      contact: { name: 'רחל לוי', phone: '+972527654321', method: stored.contact.method },
      updatedAt: NOW,
    });
    expect(updated.contact.method).toBe('whatsapp');
    expect(updated.address).toStrictEqual(stored.address);
  });

  it('replaces the number of bottles, sent as text, and nothing else', () => {
    const stored = storedOrder({ region: 'old' });

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({ bottlesEstimated: '55' }),
      NOW,
    );

    expect(patch).toStrictEqual({ bottlesEstimated: 55, updatedAt: NOW });
    expect(updated).toStrictEqual({ ...stored, bottlesEstimated: 55, updatedAt: NOW });
  });

  it('always sets updatedAt to a copy of now', () => {
    const { patch } = buildOrderPatch(storedOrder(), parseRequest({ bottlesEstimated: 40 }), NOW);

    expect(patch.updatedAt).toEqual(NOW);
    expect(patch.updatedAt).not.toBe(NOW);
  });
});

describe('buildOrderPatch: address', () => {
  it('replaces the address as a whole: a field the new address lacks is gone', () => {
    const stored = storedOrder({ address: listedAddress(RAMAT_STREET), region: 'ramat' });

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({
        address: { streetCode: RAMAT_STREET.code, houseNumber: '9', bottlesSpot: 'privateHouse' },
      }),
      NOW,
    );

    const expectedAddress = {
      streetCode: RAMAT_STREET.code,
      streetName: RAMAT_STREET.name,
      houseNumber: '9',
      bottlesSpot: 'privateHouse',
    };
    // Same street: the region is not derived again, so it is not in the patch.
    expect(patch).toStrictEqual({ address: expectedAddress, updatedAt: NOW });
    expect(updated.address).toStrictEqual(expectedAddress);
    expect(updated.region).toBe('ramat');
  });

  it('keeps the stored near street when the request has an address but no nearStreetCode', () => {
    const stored = storedOrder({
      address: { ...FREE_TEXT_ADDRESS, nearStreetCode: RAMAT_STREET.code },
      region: 'ramat',
    });

    const { patch } = buildOrderPatch(
      stored,
      parseRequest({
        address: { streetName: 'הרחוב שלי', houseNumber: '14', bottlesSpot: 'buildingEntrance' },
      }),
      NOW,
    );

    expect(patch).toStrictEqual({
      address: {
        streetName: 'הרחוב שלי',
        houseNumber: '14',
        bottlesSpot: 'buildingEntrance',
        nearStreetCode: RAMAT_STREET.code,
      },
      updatedAt: NOW,
    });
  });

  it('puts the near street from the request on the new address', () => {
    const stored = storedOrder({
      address: { ...FREE_TEXT_ADDRESS, nearStreetCode: RAMAT_STREET.code },
      region: 'ramat',
    });

    const { updated } = buildOrderPatch(
      stored,
      parseRequest({
        address: { streetName: 'רחוב אחר', houseNumber: '3', bottlesSpot: 'privateHouse' },
        nearStreetCode: OLD_STREET.code,
      }),
      NOW,
    );

    expect(updated.address).toStrictEqual({
      streetName: 'רחוב אחר',
      houseNumber: '3',
      bottlesSpot: 'privateHouse',
      nearStreetCode: OLD_STREET.code,
    });
    expect(updated.region).toBe('old');
  });
});

describe('buildOrderPatch: near street', () => {
  it('on a free-text order sets the near street and its region, and keeps the rest of the address', () => {
    const stored = storedOrder({ address: FREE_TEXT_ADDRESS });
    expect(stored).not.toHaveProperty('region');

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({ nearStreetCode: RAMAT_STREET.code }),
      NOW,
    );

    expect(patch).toStrictEqual({
      address: { ...FREE_TEXT_ADDRESS, nearStreetCode: RAMAT_STREET.code },
      region: 'ramat',
      updatedAt: NOW,
    });
    expect(updated.region).toBe('ramat');
  });

  it('replaces the region with the new near street’s', () => {
    const stored = storedOrder({
      address: { ...FREE_TEXT_ADDRESS, nearStreetCode: RAMAT_STREET.code },
      region: 'ramat',
    });

    const { patch } = buildOrderPatch(
      stored,
      parseRequest({ nearStreetCode: OLD_STREET.code }),
      NOW,
    );

    expect(patch.region).toBe('old');
    expect(patch.address?.nearStreetCode).toBe(OLD_STREET.code);
  });

  it('null removes the near street and, when the street gives no region, keeps the stored one', () => {
    const stored = storedOrder({
      address: { ...FREE_TEXT_ADDRESS, nearStreetCode: RAMAT_STREET.code },
      region: 'ramat',
    });

    const { patch, updated } = buildOrderPatch(stored, parseRequest({ nearStreetCode: null }), NOW);

    expect(patch).toStrictEqual({ address: FREE_TEXT_ADDRESS, updatedAt: NOW });
    expect(updated.address).not.toHaveProperty('nearStreetCode');
    expect(updated.region).toBe('ramat');
  });

  it('null on a listed street gives the region back to that street', () => {
    const stored = storedOrder({
      address: { ...listedAddress(RAMAT_STREET), nearStreetCode: OLD_STREET.code },
      region: 'old',
    });

    const { patch } = buildOrderPatch(stored, parseRequest({ nearStreetCode: null }), NOW);

    expect(patch.region).toBe('ramat');
    expect(patch.address).toStrictEqual(listedAddress(RAMAT_STREET));
  });

  it.skipIf(STREET_WITHOUT_REGION === undefined)(
    'a near street with no region leaves an order without one in "בלי אזור"',
    () => {
      // Narrows the type only: skipIf above already skips the test when there is no such street.
      if (STREET_WITHOUT_REGION === undefined) return;
      const stored = storedOrder({ address: FREE_TEXT_ADDRESS });

      const { patch, updated } = buildOrderPatch(
        stored,
        parseRequest({ nearStreetCode: STREET_WITHOUT_REGION.code }),
        NOW,
      );

      expect(patch).not.toHaveProperty('region');
      expect(updated).not.toHaveProperty('region');
      expect(updated.address.nearStreetCode).toBe(STREET_WITHOUT_REGION.code);
    },
  );
});

describe('buildOrderPatch: region', () => {
  it('keeps a region Yoel set by hand when only the house number changes', () => {
    // A listed street of רמת בית שמש that Yoel moved to the old city by hand.
    const stored = storedOrder({ address: listedAddress(RAMAT_STREET), region: 'old' });

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({
        address: {
          streetCode: RAMAT_STREET.code,
          houseNumber: '8',
          bottlesSpot: 'apartmentDoor',
          floorApt: 'קומה 2, דירה 5',
        },
      }),
      NOW,
    );

    expect(patch).not.toHaveProperty('region');
    expect(updated.region).toBe('old');
  });

  it('keeps a region Yoel set by hand on a free-text order when its street name is fixed', () => {
    const stored = storedOrder({ address: FREE_TEXT_ADDRESS, region: 'ramat' });

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({
        address: { streetName: 'הרחוב שלי המתוקן', houseNumber: '12', bottlesSpot: 'privateHouse' },
      }),
      NOW,
    );

    expect(patch).not.toHaveProperty('region');
    expect(updated.region).toBe('ramat');
  });

  it('derives the region again when the street code changes to a street in the other region', () => {
    const stored = storedOrder({ address: listedAddress(RAMAT_STREET), region: 'ramat' });

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({
        address: { streetCode: OLD_STREET.code, houseNumber: '7', bottlesSpot: 'privateHouse' },
      }),
      NOW,
    );

    expect(patch.region).toBe('old');
    expect(updated.region).toBe('old');
    expect(updated.address.streetName).toBe(OLD_STREET.name);
  });

  it('keeps the stored region when the street changes to a free-text one', () => {
    const stored = storedOrder({ address: listedAddress(RAMAT_STREET), region: 'ramat' });

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({
        address: { streetName: 'רחוב חדש', houseNumber: '7', bottlesSpot: 'privateHouse' },
      }),
      NOW,
    );

    expect(patch).not.toHaveProperty('region');
    expect(updated.region).toBe('ramat');
    expect(updated.address).not.toHaveProperty('streetCode');
  });

  it.skipIf(STREET_WITHOUT_REGION === undefined)(
    'keeps the stored region when the street changes to a listed street with none',
    () => {
      if (STREET_WITHOUT_REGION === undefined) return;
      const stored = storedOrder({ address: listedAddress(OLD_STREET), region: 'old' });

      const { patch, updated } = buildOrderPatch(
        stored,
        parseRequest({
          address: {
            streetCode: STREET_WITHOUT_REGION.code,
            houseNumber: '7',
            bottlesSpot: 'privateHouse',
          },
        }),
        NOW,
      );

      expect(patch).not.toHaveProperty('region');
      expect(updated.region).toBe('old');
    },
  );

  it('sets an explicit region (Yoel\'s "שינוי אזור")', () => {
    const stored = storedOrder({ address: FREE_TEXT_ADDRESS });

    const { patch } = buildOrderPatch(stored, parseRequest({ region: 'old' }), NOW);

    expect(patch).toStrictEqual({ region: 'old', updatedAt: NOW });
  });

  it('lets an explicit region win over a near street in the same request', () => {
    const stored = storedOrder({ address: FREE_TEXT_ADDRESS });

    const { patch, updated } = buildOrderPatch(
      stored,
      parseRequest({ nearStreetCode: RAMAT_STREET.code, region: 'old' }),
      NOW,
    );

    expect(patch.region).toBe('old');
    expect(updated.region).toBe('old');
    expect(updated.address.nearStreetCode).toBe(RAMAT_STREET.code);
  });

  it('leaves region out of the patch when the explicit region is the stored one', () => {
    const stored = storedOrder({ region: 'ramat' });

    const { patch } = buildOrderPatch(stored, parseRequest({ region: 'ramat' }), NOW);

    expect(patch).toStrictEqual({ updatedAt: NOW });
  });
});

describe('buildOrderPatch: the patch', () => {
  const requests: { label: string; body: UpdateOrderRequest }[] = [
    { label: 'contact', body: { contact: { name: 'רחל', phone: '0527654321' } } },
    { label: 'bottles', body: { bottlesEstimated: 31 } },
    { label: 'region', body: { region: 'old' } },
    { label: 'near street', body: { nearStreetCode: OLD_STREET.code } },
    { label: 'no near street', body: { nearStreetCode: null } },
    {
      label: 'a free-text address with empty optional fields',
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
      label: 'everything at once',
      body: {
        contact: { name: 'רחל', phone: '0527654321' },
        address: { streetCode: RAMAT_STREET.code, houseNumber: '2', bottlesSpot: 'privateHouse' },
        bottlesEstimated: 31,
        region: 'old',
        nearStreetCode: null,
      },
    },
  ];

  it.each(requests)('never holds undefined, at any depth: $label', ({ body }) => {
    const stored = storedOrder({
      address: { ...listedAddress(OLD_STREET), nearStreetCode: RAMAT_STREET.code },
      region: 'ramat',
    });

    const { patch, updated } = buildOrderPatch(stored, parseRequest(body), NOW);

    expectNoUndefined(patch);
    expectNoUndefined(updated, 'updated');
  });

  it.each(requests)('gives the order the repo stores: $label', async ({ body }) => {
    const repo = new InMemoryOrdersRepo();
    const stored = await repo.create(
      makeNewOrder({
        address: { ...listedAddress(OLD_STREET), nearStreetCode: RAMAT_STREET.code },
        region: 'ramat',
      }),
    );

    const { patch, updated } = buildOrderPatch(stored, parseRequest(body), NOW);

    expect(await repo.update(stored.id, patch)).toStrictEqual(updated);
  });

  it('throws, without customer data in the message, when the patched order would not be valid', () => {
    // A request that skipped validation: a bug in the caller, which must not reach the database.
    const unvalidated = { contact: { name: 'רחל לוי', phone: '052-7654321' } } as UpdateOrder;

    expect(() => buildOrderPatch(storedOrder(), unvalidated, NOW)).toThrow(
      'buildOrderPatch: the patched order does not match orderSchema',
    );
  });
});
