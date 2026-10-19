import { describe, expect, it } from 'vitest';
import { COLLECTOR_TABS, tabForPath } from './tabs.ts';

describe('COLLECTOR_TABS', () => {
  it('lists הזמנות, סבבים, היסטוריה in this order, each with its own path', () => {
    expect(COLLECTOR_TABS.map(({ label, to }) => [label, to])).toEqual([
      ['הזמנות', '/app/orders'],
      ['סבבים', '/app/rounds'],
      ['היסטוריה', '/app/history'],
    ]);
  });
});

describe('tabForPath', () => {
  it('opens the orders tab at /app itself', () => {
    expect(tabForPath('')).toBe('orders');
  });

  it.each([
    ['orders', 'orders'],
    ['rounds', 'rounds'],
    ['history', 'history'],
  ])('maps %s to the %s tab', (path, tab) => {
    expect(tabForPath(path)).toBe(tab);
  });

  it.each(['settings', 'rounds/abc', 'Orders', 'orders/'])('has no tab for %s', (path) => {
    expect(tabForPath(path)).toBeNull();
  });
});
