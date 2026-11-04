import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BottomNav } from './BottomNav.tsx';

/** The links of the navigation, in document order. */
function tabLinks(): HTMLElement[] {
  const nav = screen.getByRole('navigation', { name: 'ניווט באפליקציה' });
  return within(nav).getAllByRole('link');
}

describe('BottomNav', () => {
  it('shows the three tabs in order, as a list', () => {
    render(<BottomNav activeTab="orders" />);

    expect(tabLinks().map((link) => link.textContent)).toEqual(['הזמנות', 'סבבים', 'היסטוריה']);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('marks only the active tab as the current page', () => {
    render(<BottomNav activeTab="history" />);

    expect(tabLinks().map((link) => link.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page',
    ]);
  });

  it('marks no tab when the screen belongs to none', () => {
    render(<BottomNav activeTab={null} />);

    expect(tabLinks().every((link) => link.getAttribute('aria-current') === null)).toBe(true);
  });

  it('opens a tab without reloading the page', () => {
    window.history.replaceState(null, '', '/app/orders');
    render(<BottomNav activeTab="orders" />);

    fireEvent.click(screen.getByRole('link', { name: 'סבבים' }));

    expect(window.location.pathname).toBe('/app/rounds');
  });

  it('draws an icon over each label, hidden from screen readers', () => {
    render(<BottomNav activeTab="orders" />);

    for (const link of tabLinks()) {
      expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    // The accessible name stays the visible label.
    expect(screen.getByRole('link', { name: 'הזמנות' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'סבבים' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'היסטוריה' })).toBeDefined();
  });
});
