import { describe, expect, it } from 'vitest';
import { BOTTLE_VALUE_AGOROT } from './config.ts';
import {
  HISTORY_ORDER_STATUSES,
  buildHistory,
  closedAtOf,
  formatShekels,
  historyOrderSchema,
  historyQuerySchema,
  historyResponseSchema,
} from './historyApi.ts';
import type { Order } from './order.ts';

/** 43 base64url characters, the shape of a real token. */
const TOKEN = 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';
const PHONE = '+972501234567';
const CREATED_AT = new Date('2026-10-01T08:30:00.000Z');

/** A stored collected order with every internal field set; override what a test is about. */
function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: '6710f3a2c4b5d6e7f8a9b0c1',
    contact: { name: 'משה כהן', phone: PHONE, method: 'whatsapp' },
    address: {
      streetCode: 101,
      streetName: 'נחל דולב',
      houseNumber: '12א',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
      note: 'קוד לבניין 1234',
    },
    bottlesEstimated: 40,
    bottlesCollected: 45,
    status: 'collected',
    region: 'ramat',
    token: TOKEN,
    roundId: 'round-1',
    messages: [],
    source: 'form',
    createdAt: CREATED_AT,
    updatedAt: new Date('2026-10-12T10:00:00.000Z'),
    collectedAt: new Date('2026-10-12T10:00:00.000Z'),
    ...overrides,
  };
}

/** A stored cancelled order: no collection, cancelled at `cancelledAt`. */
function makeCancelledOrder(overrides: Partial<Order> = {}): Order {
  const order: Order = {
    ...makeOrder(),
    id: 'cancelled-1',
    status: 'cancelled',
    cancelledAt: new Date('2026-10-05T09:00:00.000Z'),
    ...overrides,
  };
  // A cancelled order was never collected: drop the collected order's fields (unless overridden).
  if (!('bottlesCollected' in overrides)) delete order.bottlesCollected;
  if (!('collectedAt' in overrides)) delete order.collectedAt;
  return order;
}

describe('HISTORY_ORDER_STATUSES', () => {
  it('is the two final statuses', () => {
    expect(HISTORY_ORDER_STATUSES).toEqual(['collected', 'cancelled']);
  });
});

describe('closedAtOf', () => {
  it('is collectedAt for a collected order', () => {
    const order = makeOrder();
    expect(closedAtOf(order)).toBe(order.collectedAt);
  });

  it('is cancelledAt for a cancelled order', () => {
    const order = makeCancelledOrder();
    expect(closedAtOf(order)).toBe(order.cancelledAt);
  });

  it('is undefined for an open order, whatever timestamps it carries', () => {
    for (const status of ['waiting', 'pending', 'confirmed'] as const) {
      expect(closedAtOf(makeOrder({ status })), status).toBeUndefined();
    }
  });

  it('is undefined for a closed order missing its timestamp', () => {
    expect(closedAtOf(makeOrder({ collectedAt: undefined }))).toBeUndefined();
    expect(closedAtOf(makeCancelledOrder({ cancelledAt: undefined }))).toBeUndefined();
  });
});

describe('buildHistory', () => {
  it('sums the collected bottles, counts the addresses and values them at 20 agorot', () => {
    const history = buildHistory('2026-10', [
      makeOrder({ id: 'a', bottlesCollected: 45 }),
      makeOrder({ id: 'b', bottlesCollected: 30 }),
    ]);
    expect(BOTTLE_VALUE_AGOROT).toBe(20);
    expect(history.month).toBe('2026-10');
    expect(history.totals).toEqual({
      bottlesCollected: 75,
      addressesCollected: 2,
      valueAgorot: 1500,
    });
  });

  it('counts the same customer collected twice as two addresses', () => {
    const history = buildHistory('2026-10', [
      makeOrder({ id: 'a', bottlesCollected: 30 }),
      makeOrder({ id: 'b', bottlesCollected: 31 }),
    ]);
    expect(history.totals.addressesCollected).toBe(2);
  });

  it('lists a cancelled order but counts it in none of the totals', () => {
    const history = buildHistory('2026-10', [
      makeOrder({ id: 'a', bottlesCollected: 45 }),
      makeCancelledOrder({ id: 'c', bottlesEstimated: 200 }),
    ]);
    expect(history.totals).toEqual({
      bottlesCollected: 45,
      addressesCollected: 1,
      valueAgorot: 900,
    });
    expect(history.orders.map((order) => order.id)).toEqual(['a', 'c']);
    expect(history.orders[1]).toMatchObject({ status: 'cancelled', bottlesEstimated: 200 });
  });

  it('adds 0 bottles for a collected order with no recorded count, but counts its address', () => {
    const history = buildHistory('2026-10', [makeOrder({ bottlesCollected: undefined })]);
    expect(history.totals).toEqual({ bottlesCollected: 0, addressesCollected: 1, valueAgorot: 0 });
  });

  it('gives zeros and an empty list for a month with no closed orders', () => {
    expect(buildHistory('2026-10', [])).toEqual({
      month: '2026-10',
      totals: { bottlesCollected: 0, addressesCollected: 0, valueAgorot: 0 },
      orders: [],
    });
  });

  it('lists the newest closed first, by collectedAt or cancelledAt', () => {
    const history = buildHistory('2026-10', [
      makeOrder({ id: 'early', collectedAt: new Date('2026-10-02T10:00:00Z') }),
      makeCancelledOrder({ id: 'middle', cancelledAt: new Date('2026-10-15T10:00:00Z') }),
      makeOrder({ id: 'late', collectedAt: new Date('2026-10-30T10:00:00Z') }),
    ]);
    expect(history.orders.map((order) => order.id)).toEqual(['late', 'middle', 'early']);
    expect(history.orders[0]?.closedAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('keeps the input order for orders closed at the same instant', () => {
    const at = new Date('2026-10-12T10:00:00Z');
    const history = buildHistory('2026-10', [
      makeOrder({ id: 'first', collectedAt: at }),
      makeOrder({ id: 'second', collectedAt: at }),
    ]);
    expect(history.orders.map((order) => order.id)).toEqual(['first', 'second']);
  });

  it('drops an open order and a closed one without its timestamp', () => {
    const history = buildHistory('2026-10', [
      makeOrder({ id: 'kept' }),
      makeOrder({ id: 'open', status: 'confirmed', bottlesCollected: 99 }),
      makeOrder({ id: 'broken', collectedAt: undefined, bottlesCollected: 99 }),
    ]);
    expect(history.orders.map((order) => order.id)).toEqual(['kept']);
    expect(history.totals.bottlesCollected).toBe(45);
  });

  it('does not filter by month: the caller passes the month it means', () => {
    const history = buildHistory('2026-10', [
      makeOrder({ collectedAt: new Date('2026-12-01T10:00:00Z') }),
    ]);
    expect(history.orders).toHaveLength(1);
  });

  it('keeps only the allow-listed fields: no phone, no token, no message log', () => {
    const [item] = buildHistory('2026-10', [makeOrder()]).orders;
    expect(item).toEqual({
      id: '6710f3a2c4b5d6e7f8a9b0c1',
      status: 'collected',
      contact: { name: 'משה כהן' },
      address: { streetName: 'נחל דולב', houseNumber: '12א' },
      bottlesEstimated: 40,
      bottlesCollected: 45,
      closedAt: new Date('2026-10-12T10:00:00.000Z'),
    });
    const json = JSON.stringify(item);
    expect(json).not.toContain(PHONE);
    expect(json).not.toContain(TOKEN);
  });

  it('round-trips through JSON and historyResponseSchema, closedAt back as a Date', () => {
    const history = buildHistory('2026-10', [
      makeOrder({ id: 'a' }),
      makeCancelledOrder({ id: 'c' }),
    ]);
    const parsed = historyResponseSchema.parse(JSON.parse(JSON.stringify(history)));
    expect(parsed).toEqual(history);
    expect(parsed.orders[0]?.closedAt).toBeInstanceOf(Date);
  });
});

describe('historyOrderSchema', () => {
  it('refuses an open status', () => {
    const result = historyOrderSchema.safeParse({
      ...makeOrder({ status: 'waiting' }),
      closedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('requires closedAt', () => {
    expect(historyOrderSchema.safeParse(makeOrder()).success).toBe(false);
  });
});

describe('historyResponseSchema', () => {
  it('refuses a month that is not YYYY-MM', () => {
    const result = historyResponseSchema.safeParse({
      month: '2026-13',
      totals: { bottlesCollected: 0, addressesCollected: 0, valueAgorot: 0 },
      orders: [],
    });
    expect(result.success).toBe(false);
  });

  it('refuses negative or fractional totals', () => {
    for (const totals of [
      { bottlesCollected: -1, addressesCollected: 0, valueAgorot: 0 },
      { bottlesCollected: 0, addressesCollected: 0.5, valueAgorot: 0 },
    ]) {
      expect(
        historyResponseSchema.safeParse({ month: '2026-10', totals, orders: [] }).success,
      ).toBe(false);
    }
  });
});

describe('historyQuerySchema', () => {
  it('accepts a calendar month', () => {
    expect(historyQuerySchema.parse({ month: '2026-10' })).toEqual({ month: '2026-10' });
  });

  it('rejects a missing, repeated or malformed month', () => {
    for (const query of [
      {},
      { month: ['2026-10', '2026-11'] },
      { month: '2026-13' },
      { month: '2026-1' },
      { month: '26-10' },
      { month: '' },
    ]) {
      expect(historyQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });
});

describe('formatShekels', () => {
  it('shows whole shekels without decimals', () => {
    expect(formatShekels(0)).toBe('0 ₪');
    expect(formatShekels(1200)).toBe('12 ₪');
    expect(formatShekels(1500)).toBe('15 ₪');
  });

  it('shows two decimals otherwise', () => {
    expect(formatShekels(960)).toBe('9.60 ₪');
    expect(formatShekels(905)).toBe('9.05 ₪');
    expect(formatShekels(20)).toBe('0.20 ₪');
    expect(formatShekels(123456)).toBe('1234.56 ₪');
  });

  it('throws a RangeError for a negative or non-integer value', () => {
    for (const agorot of [-20, 9.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatShekels(agorot), String(agorot)).toThrow(RangeError);
    }
  });
});
