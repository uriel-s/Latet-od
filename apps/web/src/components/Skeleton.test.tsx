import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './Skeleton.tsx';

describe('Skeleton', () => {
  it('keeps "טוען..." findable as a status', () => {
    render(<Skeleton />);
    expect(screen.getByRole('status').textContent).toBe('טוען...');
    expect(screen.getByText('טוען...')).toBeTruthy();
  });

  it('draws the requested number of hidden grey cards', () => {
    const { container } = render(<Skeleton cards={2} />);
    expect(container.querySelectorAll('.skeleton-block')).toHaveLength(2);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
