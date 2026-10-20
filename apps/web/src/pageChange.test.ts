import { describe, expect, it } from 'vitest';
import { pageTitle } from './pageChange.ts';

describe('pageTitle', () => {
  it('puts the page heading before the app name', () => {
    expect(pageTitle('הזמנות', 'לתת עוד')).toBe('הזמנות | לתת עוד');
  });

  it('trims the heading', () => {
    expect(pageTitle('  סבבים \n', 'לתת עוד')).toBe('סבבים | לתת עוד');
  });

  it.each([null, '', '   '])('is the app name alone for the heading %j', (heading) => {
    expect(pageTitle(heading, 'לתת עוד')).toBe('לתת עוד');
  });
});
