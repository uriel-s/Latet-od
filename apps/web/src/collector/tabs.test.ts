import { describe, expect, it } from 'vitest';
import { COLLECTOR_TABS, ordersView, tabForPath } from './tabs.ts';

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
    ['orders/new', 'orders'],
    ['orders/plan', 'orders'],
    ['orders/64f0c0ffee0000000000abcd', 'orders'],
    ['orders/a%2Fb', 'orders'],
    ['rounds', 'rounds'],
    ['history', 'history'],
  ])('maps %s to the %s tab', (path, tab) => {
    expect(tabForPath(path)).toBe(tab);
  });

  it.each([
    'settings',
    'rounds/abc',
    'Orders',
    'orders/',
    'orders/a/b',
    'orders/new/edit',
    'orders/plan/x',
    'orders/%E0%A4%A',
    'history/orders',
  ])('has no tab for %s', (path) => {
    expect(tabForPath(path)).toBeNull();
  });
});

describe('ordersView', () => {
  it.each(['', 'orders'])('shows the list at "%s"', (path) => {
    expect(ordersView(path)).toEqual({ view: 'list' });
  });

  it('shows the add screen at orders/new', () => {
    expect(ordersView('orders/new')).toEqual({ view: 'new' });
  });

  it('shows the planning screen at orders/plan, not the edit screen of an order called plan', () => {
    expect(ordersView('orders/plan')).toEqual({ view: 'plan' });
  });

  it('shows the edit screen of the order in the path', () => {
    expect(ordersView('orders/64f0c0ffee0000000000abcd')).toEqual({
      view: 'edit',
      id: '64f0c0ffee0000000000abcd',
    });
  });

  it('decodes the id the list encoded into the link', () => {
    expect(ordersView('orders/a%2Fb%3Fc')).toEqual({ view: 'edit', id: 'a/b?c' });
  });

  it.each([
    'orders/',
    'orders/a/b',
    'orders/new/x',
    'orders/plan/x',
    'orders/%E0%A4%A',
    'rounds',
    'history',
    'Orders',
    'orders//x',
    'settings/orders',
  ])('has no orders screen at %s', (path) => {
    expect(ordersView(path)).toBeNull();
  });
});
