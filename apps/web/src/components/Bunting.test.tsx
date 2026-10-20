import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Bunting } from './Bunting.tsx';

describe('Bunting', () => {
  it('is decoration: hidden from screen readers and exposing nothing to read or tap', () => {
    const { container } = render(<Bunting />);

    const garland = container.querySelector('svg');
    expect(garland?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
