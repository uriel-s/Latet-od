import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from './Icon.tsx';

describe('Icon', () => {
  it('has exactly the agreed set of names', () => {
    expect([...ICON_NAMES].sort()).toEqual(
      [
        'navigate',
        'phone',
        'check',
        'more',
        'pin',
        'calendar',
        'bottle',
        'heart',
        'list',
        'clock',
        'route',
        'plus',
        'minus',
        'door',
        'building',
        'home',
      ].sort(),
    );
  });

  it.each(ICON_NAMES)('draws "%s" as one hidden svg with shapes and nothing to read', (name) => {
    const { container, unmount } = render(<Icon name={name} />);

    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    const svg = svgs[0];
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(svg?.querySelectorAll('path, circle, rect').length).toBeGreaterThan(0);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toBe('');
    unmount();
  });

  it('draws in the text colour at a size relative to the text', () => {
    const { container } = render(<Icon name="phone" />);

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('width')).toBe('1.25em');
    expect(svg?.getAttribute('height')).toBe('1.25em');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('gives every name its own drawing', () => {
    const drawings = ICON_NAMES.map((name) => {
      const { container, unmount } = render(<Icon name={name} />);
      const drawing = container.querySelector('svg')?.innerHTML;
      unmount();
      return drawing;
    });

    expect(new Set(drawings).size).toBe(ICON_NAMES.length);
  });

  it('passes a class name through to the svg', () => {
    const { container } = render(<Icon name="check" className="done-mark" />);

    expect(container.querySelector('svg')?.getAttribute('class')).toBe('done-mark');
  });
});
