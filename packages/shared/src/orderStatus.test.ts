import { describe, expect, it } from 'vitest';
import {
  OPEN_ORDER_STATUSES,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  ORDER_TRANSITIONS,
  canDeleteOrder,
  canTransition,
  isOpenStatus,
  orderStatusSchema,
  type OrderStatus,
} from './orderStatus.ts';

/** The arrows of the spec §4 state diagram, written out independently of ORDER_TRANSITIONS. */
const SPEC_EDGES: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
  ['waiting', 'pending'],
  ['pending', 'confirmed'],
  ['pending', 'waiting'],
  ['confirmed', 'waiting'],
  ['confirmed', 'collected'],
  ['waiting', 'cancelled'],
  ['pending', 'cancelled'],
  ['confirmed', 'cancelled'],
];

describe('orderStatusSchema', () => {
  it('accepts every status', () => {
    for (const status of ORDER_STATUSES) {
      expect(orderStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects statuses the spec removed', () => {
    for (const status of ['new', 'archived', 'Pending_Confirmation', '']) {
      expect(orderStatusSchema.safeParse(status).success, status).toBe(false);
    }
  });
});

describe('ORDER_STATUS_LABELS', () => {
  it('names every status in Hebrew', () => {
    expect(ORDER_STATUS_LABELS).toEqual({
      waiting: 'ממתינה לסבב',
      pending: 'ממתינה לאישור',
      confirmed: 'אושרה',
      collected: 'נאספה',
      cancelled: 'בוטלה',
    });
  });
});

describe('canTransition', () => {
  it('allows every arrow of the spec diagram', () => {
    for (const [from, to] of SPEC_EDGES) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
    }
  });

  it('allows nothing else', () => {
    const allowed = new Set(SPEC_EDGES.map(([from, to]) => `${from} → ${to}`));
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const edge = `${from} → ${to}`;
        expect(canTransition(from, to), edge).toBe(allowed.has(edge));
      }
    }
  });

  it('lets nothing leave collected or cancelled', () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransition('collected', to), `collected → ${to}`).toBe(false);
      expect(canTransition('cancelled', to), `cancelled → ${to}`).toBe(false);
    }
    expect(ORDER_TRANSITIONS.collected).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it('refuses to cancel a collected order', () => {
    expect(canTransition('collected', 'cancelled')).toBe(false);
  });

  it('refuses to confirm or collect an order that is not in a round', () => {
    expect(canTransition('waiting', 'confirmed')).toBe(false);
    expect(canTransition('waiting', 'collected')).toBe(false);
  });

  it('refuses to collect an order the customer has not confirmed', () => {
    expect(canTransition('pending', 'collected')).toBe(false);
  });

  it('refuses to reopen a cancelled order', () => {
    expect(canTransition('cancelled', 'waiting')).toBe(false);
  });

  it('does not count staying in the same status as a transition', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });
});

describe('OPEN_ORDER_STATUSES', () => {
  it('is waiting, pending and confirmed', () => {
    expect(OPEN_ORDER_STATUSES).toEqual(['waiting', 'pending', 'confirmed']);
  });

  it('holds exactly the statuses an order can still move out of', () => {
    const notFinal = ORDER_STATUSES.filter((status) => ORDER_TRANSITIONS[status].length > 0);
    expect([...OPEN_ORDER_STATUSES]).toEqual(notFinal);
  });
});

describe('isOpenStatus', () => {
  it('is true for waiting, pending and confirmed', () => {
    expect(isOpenStatus('waiting')).toBe(true);
    expect(isOpenStatus('pending')).toBe(true);
    expect(isOpenStatus('confirmed')).toBe(true);
  });

  it('is false for collected and cancelled', () => {
    expect(isOpenStatus('collected')).toBe(false);
    expect(isOpenStatus('cancelled')).toBe(false);
  });
});

describe('canDeleteOrder', () => {
  it('allows a waiting or cancelled order that is in no round', () => {
    expect(canDeleteOrder({ status: 'waiting' })).toBe(true);
    expect(canDeleteOrder({ status: 'cancelled' })).toBe(true);
  });

  it('refuses a collected order: the statistics count it', () => {
    expect(canDeleteOrder({ status: 'collected' })).toBe(false);
  });

  it('refuses a pending or confirmed order, which is in a round', () => {
    expect(canDeleteOrder({ status: 'pending', roundId: 'round-1' })).toBe(false);
    expect(canDeleteOrder({ status: 'confirmed', roundId: 'round-1' })).toBe(false);
  });

  it('refuses an order a round still names, a cancelled one included', () => {
    expect(canDeleteOrder({ status: 'cancelled', roundId: 'round-1' })).toBe(false);
  });
});
