import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

describe('App', () => {
  it('shows the project name from @bottlerun/shared', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'לתת עוד' })).toBeDefined();
    expect(screen.getByText('hello')).toBeDefined();
  });
});
