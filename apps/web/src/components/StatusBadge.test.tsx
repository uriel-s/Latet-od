import { ORDER_STATUSES, ORDER_STATUS_LABELS } from '@bottlerun/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STATUS_BADGE_STYLES, StatusBadge } from './StatusBadge.tsx';

describe('StatusBadge', () => {
  it.each(ORDER_STATUSES)('shows "%s" in Hebrew with the badge class of its tone', (status) => {
    const { unmount } = render(<StatusBadge status={status} />);

    const badge = screen.getByText(ORDER_STATUS_LABELS[status]);
    expect(badge.classList.contains('badge')).toBe(true);
    expect(badge.classList.contains(`badge-${STATUS_BADGE_STYLES[status].tone}`)).toBe(true);
    unmount();
  });

  it('gives waiting and pending amber, confirmed and collected green, cancelled gray', () => {
    const tones = Object.fromEntries(
      ORDER_STATUSES.map((status) => [status, STATUS_BADGE_STYLES[status].tone]),
    );

    expect(tones).toEqual({
      waiting: 'amber',
      pending: 'amber',
      confirmed: 'green',
      collected: 'green',
      cancelled: 'gray',
    });
  });

  it('draws a hidden icon for every status, a different one each, so colour is not the only signal', () => {
    const drawings = ORDER_STATUSES.map((status) => {
      const { unmount } = render(<StatusBadge status={status} />);
      const svgs = screen.getByText(ORDER_STATUS_LABELS[status]).querySelectorAll('svg');
      expect(svgs).toHaveLength(1);
      expect(svgs[0]?.getAttribute('aria-hidden')).toBe('true');
      const drawing = svgs[0]?.innerHTML;
      unmount();
      return drawing;
    });

    expect(new Set(drawings).size).toBe(ORDER_STATUSES.length);
  });

  it('passes a class name through next to its own classes', () => {
    render(<StatusBadge status="confirmed" className="row-status" />);

    const badge = screen.getByText('אושרה');
    expect(badge.className).toBe('badge badge-green row-status');
  });
});
