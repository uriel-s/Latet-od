import { describe, expect, it } from 'vitest';
import {
  COLLECTOR_ORDER_MESSAGES,
  ORDER_GROUP_KEYS,
  ORDER_GROUP_LABELS,
  REGION_LABELS,
  collectorOrderResponseSchema,
  collectorOrderSchema,
  collectorOrdersResponseSchema,
  groupWaitingOrders,
  toCollectorOrder,
  updateOrderRequestSchema,
  type CollectorOrder,
  type UpdateOrderRequest,
} from './collectorOrdersApi.ts';
import { ORDER_FORM_ERRORS, type Order } from './order.ts';
import { STREETS, type Street } from './streets.ts';
import { MADE_ORDER_TOKEN, firstRealStreet, makeOrder } from './testing/index.ts';

const CREATED_AT = new Date('2026-10-19T08:30:00.000Z');

const hasPoint = (street: Street): boolean => street.lat !== undefined && street.lng !== undefined;

/** A listed street in רמת בית שמש, with a map point. */
const RAMAT_STREET = firstRealStreet((street) => street.region === 'ramat' && hasPoint(street));
/** A listed street in the old city, with a map point. */
const OLD_STREET = firstRealStreet((street) => street.region === 'old' && hasPoint(street));
/** A listed street the geocoder did not find: no point, no region. */
const POINTLESS_STREET = firstRealStreet((street) => !hasPoint(street));
const UNKNOWN_STREET_CODE = Math.max(...STREETS.map((street) => street.code)) + 1;

/**
 * What these tests start from, on top of makeOrder: a waiting order back from a round (lastMiss,
 * with that round's message), on a listed street of רמת בית שמש with every internal field set.
 */
const BACK_FROM_ROUND: Partial<Order> = {
  address: {
    streetCode: RAMAT_STREET.code,
    streetName: RAMAT_STREET.name,
    houseNumber: '12א',
    bottlesSpot: 'apartmentDoor',
    floorApt: 'קומה 3, דירה 12',
    note: 'קוד לבניין 1234',
  },
  region: 'ramat',
  lastMiss: { date: '2026-10-12', reason: 'notConfirmed', roundId: 'round-0' },
  messages: [
    {
      kind: 'confirmRequest',
      at: CREATED_AT,
      mode: 'manual',
      url: 'https://wa.me/972501234567?text=x',
    },
  ],
};

/** A free-text street ("הרחוב שלי לא ברשימה"): no street code, so no region and no point. */
const FREE_TEXT_ADDRESS: Order['address'] = {
  streetName: 'רחוב חדש',
  houseNumber: '5',
  bottlesSpot: 'privateHouse',
};

/** A collector order with a distinct id, bottles and region, for the grouping tests. */
function orderToGroup(
  id: string,
  bottlesEstimated: number,
  region: Order['region'],
): CollectorOrder {
  const order = makeOrder({ ...BACK_FROM_ROUND, id, bottlesEstimated });
  if (region === undefined) {
    delete order.region;
  } else {
    order.region = region;
  }
  return toCollectorOrder(order);
}

/** Validates a PATCH body that must fail and returns its issues as `path: message`. */
function updateIssuesOf(body: unknown): string[] {
  const result = updateOrderRequestSchema.safeParse(body);
  if (result.success) throw new Error('expected the PATCH body to be rejected');
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('labels', () => {
  it('names one group per key, the regions with their region names', () => {
    expect(Object.keys(ORDER_GROUP_LABELS)).toEqual([...ORDER_GROUP_KEYS]);
    expect(ORDER_GROUP_LABELS).toEqual({
      ramat: 'רמת בית שמש',
      old: 'בית שמש',
      none: 'בלי אזור',
    });
    expect(REGION_LABELS).toEqual({ ramat: 'רמת בית שמש', old: 'בית שמש' });
  });
});

describe('toCollectorOrder', () => {
  it('keeps the fields Yoel needs and strips token, message log and contact method', () => {
    expect(toCollectorOrder(makeOrder(BACK_FROM_ROUND))).toStrictEqual({
      id: '6710f3a2c4b5d6e7f8a9b0c1',
      contact: { name: 'משה כהן', phone: '+972501234567' },
      address: {
        streetCode: RAMAT_STREET.code,
        streetName: RAMAT_STREET.name,
        houseNumber: '12א',
        bottlesSpot: 'apartmentDoor',
        floorApt: 'קומה 3, דירה 12',
        note: 'קוד לבניין 1234',
      },
      bottlesEstimated: 45,
      status: 'waiting',
      region: 'ramat',
      lastMiss: { date: '2026-10-12', reason: 'notConfirmed', roundId: 'round-0' },
      source: 'form',
      createdAt: CREATED_AT,
      hasLocation: true,
      deletable: true,
    });
  });

  it('marks an order as deletable by canDeleteOrder, without exposing the roundId', () => {
    expect(toCollectorOrder(makeOrder(BACK_FROM_ROUND)).deletable).toBe(true);
    expect(toCollectorOrder(makeOrder({ ...BACK_FROM_ROUND, roundId: 'round-1' })).deletable).toBe(
      false,
    );
    expect(
      toCollectorOrder(makeOrder({ ...BACK_FROM_ROUND, status: 'pending', roundId: 'round-1' }))
        .deletable,
    ).toBe(false);
    expect(toCollectorOrder(makeOrder({ ...BACK_FROM_ROUND, status: 'collected' })).deletable).toBe(
      false,
    );
  });

  it('never carries the token, the message log or the other internal fields', () => {
    const collectorOrder = toCollectorOrder(
      makeOrder({
        ...BACK_FROM_ROUND,
        roundId: 'round-1',
        bottlesCollected: 50,
        collectedAt: CREATED_AT,
      }),
    );
    for (const key of ['token', 'messages', 'roundId', 'updatedAt']) {
      expect(collectorOrder, key).not.toHaveProperty(key);
    }
    expect(collectorOrder.contact).not.toHaveProperty('method');
    expect(JSON.stringify(collectorOrder)).not.toContain(MADE_ORDER_TOKEN);
  });

  it('keeps the recorded count of a collected order, for the donation line', () => {
    expect(
      toCollectorOrder(makeOrder({ ...BACK_FROM_ROUND, bottlesCollected: 50 })).bottlesCollected,
    ).toBe(50);
    expect(toCollectorOrder(makeOrder(BACK_FROM_ROUND))).not.toHaveProperty('bottlesCollected');
  });

  it('keeps the near street, which Yoel sees and changes', () => {
    const order = makeOrder({
      ...BACK_FROM_ROUND,
      address: { ...FREE_TEXT_ADDRESS, nearStreetCode: OLD_STREET.code },
    });
    expect(toCollectorOrder(order).address.nearStreetCode).toBe(OLD_STREET.code);
  });

  it('has a location for a listed street with a point', () => {
    expect(toCollectorOrder(makeOrder(BACK_FROM_ROUND)).hasLocation).toBe(true);
  });

  it('has no location for a free-text street', () => {
    const order = makeOrder({ ...BACK_FROM_ROUND, address: FREE_TEXT_ADDRESS });
    delete order.region;
    expect(toCollectorOrder(order).hasLocation).toBe(false);
  });

  it('has no location for a listed street without a point', () => {
    const order = makeOrder({
      ...BACK_FROM_ROUND,
      address: {
        ...FREE_TEXT_ADDRESS,
        streetCode: POINTLESS_STREET.code,
        streetName: POINTLESS_STREET.name,
      },
    });
    expect(toCollectorOrder(order).hasLocation).toBe(false);
  });

  it('has a location for a free-text street once its near street has a point', () => {
    const order = makeOrder({
      ...BACK_FROM_ROUND,
      address: { ...FREE_TEXT_ADDRESS, nearStreetCode: OLD_STREET.code },
    });
    expect(toCollectorOrder(order).hasLocation).toBe(true);
  });

  it('leaves out region and lastMiss when the order has none', () => {
    const order = makeOrder({ ...BACK_FROM_ROUND, address: FREE_TEXT_ADDRESS });
    delete order.region;
    delete order.lastMiss;
    const collectorOrder = toCollectorOrder(order);
    expect(collectorOrder).not.toHaveProperty('region');
    expect(collectorOrder).not.toHaveProperty('lastMiss');
  });

  it('gives an order the collector schema accepts, also after a JSON round trip', () => {
    const collectorOrder = toCollectorOrder(makeOrder(BACK_FROM_ROUND));
    expect(collectorOrderSchema.parse(collectorOrder)).toStrictEqual(collectorOrder);
    // The api sends createdAt as an ISO string; the web reads it back as the same Date.
    const fromJson = collectorOrderSchema.parse(JSON.parse(JSON.stringify(collectorOrder)));
    expect(fromJson).toStrictEqual(collectorOrder);
    expect(fromJson.createdAt).toBeInstanceOf(Date);
  });
});

describe('collectorOrderResponseSchema', () => {
  it('reads an order back from JSON with its Date', () => {
    const response = { order: toCollectorOrder(makeOrder(BACK_FROM_ROUND)) };
    const parsed = collectorOrderResponseSchema.parse(JSON.parse(JSON.stringify(response)));
    expect(parsed).toStrictEqual(response);
  });
});

describe('groupWaitingOrders', () => {
  it('always returns the three groups in screen order, empty ones with zero totals', () => {
    expect(groupWaitingOrders([])).toStrictEqual([
      { key: 'ramat', orderCount: 0, bottlesTotal: 0, orders: [] },
      { key: 'old', orderCount: 0, bottlesTotal: 0, orders: [] },
      { key: 'none', orderCount: 0, bottlesTotal: 0, orders: [] },
    ]);
  });

  it('puts each order in the group of its region, and one without a region under none', () => {
    const ramatOrder = orderToGroup('a', 40, 'ramat');
    const oldOrder = orderToGroup('b', 50, 'old');
    const noRegionOrder = orderToGroup('c', 60, undefined);
    const groups = groupWaitingOrders([noRegionOrder, oldOrder, ramatOrder]);
    expect(groups.map((group) => group.key)).toEqual(['ramat', 'old', 'none']);
    expect(groups.map((group) => group.orders)).toStrictEqual([
      [ramatOrder],
      [oldOrder],
      [noRegionOrder],
    ]);
  });

  it('counts the orders and sums the estimated bottles of each group', () => {
    const groups = groupWaitingOrders([
      orderToGroup('a', 40, 'ramat'),
      orderToGroup('b', 30, 'old'),
      orderToGroup('c', 45, 'ramat'),
      orderToGroup('d', 100, 'ramat'),
    ]);
    expect(
      groups.map(({ key, orderCount, bottlesTotal }) => [key, orderCount, bottlesTotal]),
    ).toEqual([
      ['ramat', 3, 185],
      ['old', 1, 30],
      ['none', 0, 0],
    ]);
  });

  it('keeps the input order inside a group', () => {
    const orders = ['first', 'second', 'third'].map((id) => orderToGroup(id, 40, 'old'));
    const oldGroup = groupWaitingOrders(orders)[1];
    expect(oldGroup?.orders.map((order) => order.id)).toEqual(['first', 'second', 'third']);
  });

  it('gives a response the response schema accepts, also after a JSON round trip', () => {
    const response = {
      groups: groupWaitingOrders([
        orderToGroup('a', 40, 'ramat'),
        orderToGroup('b', 50, undefined),
      ]),
    };
    expect(collectorOrdersResponseSchema.parse(JSON.parse(JSON.stringify(response)))).toStrictEqual(
      response,
    );
  });
});

describe('updateOrderRequestSchema', () => {
  it('accepts each key on its own', () => {
    const bodies: UpdateOrderRequest[] = [
      { contact: { name: 'משה כהן', phone: '050-1234567' } },
      { address: { streetCode: OLD_STREET.code, houseNumber: '7', bottlesSpot: 'privateHouse' } },
      { bottlesEstimated: 60 },
      { region: 'old' },
      { nearStreetCode: OLD_STREET.code },
      { nearStreetCode: null },
    ];
    for (const body of bodies) {
      expect(updateOrderRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it('applies the form rules: phone in E.164, trimmed name, official street name', () => {
    expect(
      updateOrderRequestSchema.parse({
        contact: { name: ' משה כהן ', phone: '050-1234567' },
        address: { streetCode: OLD_STREET.code, houseNumber: ' 7 ', bottlesSpot: 'privateHouse' },
        bottlesEstimated: '60',
      }),
    ).toStrictEqual({
      contact: { name: 'משה כהן', phone: '+972501234567' },
      address: {
        streetCode: OLD_STREET.code,
        streetName: OLD_STREET.name,
        houseNumber: '7',
        bottlesSpot: 'privateHouse',
      },
      bottlesEstimated: 60,
    });
  });

  it('rejects fewer than 20 bottles with the form message', () => {
    expect(updateIssuesOf({ bottlesEstimated: 19 })).toEqual([
      `bottlesEstimated: ${ORDER_FORM_ERRORS.bottlesTooFew}`,
    ]);
  });

  it('refuses a status, or any other unknown key', () => {
    const bodies: [Record<string, unknown>, string][] = [
      [{ status: 'cancelled' }, 'status'],
      [{ region: 'old', token: MADE_ORDER_TOKEN }, 'token'],
    ];
    for (const [body, unknownKey] of bodies) {
      const result = updateOrderRequestSchema.safeParse(body);
      expect(result.success, unknownKey).toBe(false);
      expect(result.error?.issues, unknownKey).toContainEqual(
        expect.objectContaining({ code: 'unrecognized_keys', keys: [unknownKey] }),
      );
    }
  });

  it('refuses a body with nothing to change', () => {
    expect(updateOrderRequestSchema.safeParse({}).success).toBe(false);
    expect(updateOrderRequestSchema.safeParse({ region: undefined }).success).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, [], 'old', 42]) {
      expect(updateOrderRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('keeps null as the removal of the near street', () => {
    expect(updateOrderRequestSchema.parse({ nearStreetCode: null })).toStrictEqual({
      nearStreetCode: null,
    });
  });

  it('rejects a near street that is not in the list', () => {
    for (const nearStreetCode of [UNKNOWN_STREET_CODE, 1.5, '101']) {
      expect(updateIssuesOf({ nearStreetCode }), String(nearStreetCode)).toEqual([
        `nearStreetCode: ${ORDER_FORM_ERRORS.streetNotFound}`,
      ]);
    }
  });

  it('accepts only the two regions', () => {
    for (const region of ['ramat', 'old']) {
      expect(updateOrderRequestSchema.safeParse({ region }).success, region).toBe(true);
    }
    for (const region of ['none', '', 'Ramat', null]) {
      expect(updateIssuesOf({ region })[0], String(region)).toMatch(/^region: /);
    }
  });
});

describe('COLLECTOR_ORDER_MESSAGES', () => {
  it('has a plain-Hebrew message for a closed order and a missing one', () => {
    expect(COLLECTOR_ORDER_MESSAGES.orderClosed).toBe('ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.');
    expect(COLLECTOR_ORDER_MESSAGES.orderNotFound).toBe('ההזמנה לא נמצאה.');
  });
});
