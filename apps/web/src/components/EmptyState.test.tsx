import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState.tsx';

describe('EmptyState', () => {
  it('shows the sentence', () => {
    render(<EmptyState icon="list" text="אין כלום" />);
    expect(screen.getByText('אין כלום')).toBeTruthy();
  });

  it('shows the action when given', () => {
    render(<EmptyState icon="calendar" text="אין סבב" action={<button>תכנון</button>} />);
    expect(screen.getByRole('button', { name: 'תכנון' })).toBeTruthy();
  });

  it('draws a decorative icon hidden from screen readers', () => {
    const { container } = render(<EmptyState icon="heart" text="ריק" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
