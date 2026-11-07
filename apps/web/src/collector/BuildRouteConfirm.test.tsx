// The question's words. The component itself is tested through the rounds screen
// (RoundsScreen.test.tsx, "התחל מסלול"), which owns its request and its guard.
import { describe, expect, it } from 'vitest';
import {
  BUILD_ROUTE_FAILED_MESSAGE,
  BUILD_ROUTE_LABEL,
  BUILD_ROUTE_YES_LABEL,
  BUILDING_ROUTE_LABEL,
  buildRouteQuestion,
} from './BuildRouteConfirm.tsx';

describe('build-route texts', () => {
  // The rounds-screen tests look the button up through the constants, so a reverted wording
  // would still pass there; these literals pin what Yoel actually reads.
  it('pin the words Yoel reads', () => {
    expect(BUILD_ROUTE_LABEL).toBe('התחל מסלול');
    expect(BUILD_ROUTE_YES_LABEL).toBe('כן, להתחיל');
    expect(BUILDING_ROUTE_LABEL).toBe('מתחיל מסלול...');
    expect(BUILD_ROUTE_FAILED_MESSAGE).toBe('לא הצלחנו להתחיל את המסלול. נא לנסות שוב.');
  });
});

describe('buildRouteQuestion', () => {
  it('says how many customers the route takes in', () => {
    expect(buildRouteQuestion(3)).toBe('המסלול יכלול 3 לקוחות. להתחיל מסלול?');
  });

  it('says it of one customer in the singular', () => {
    expect(buildRouteQuestion(1)).toBe('המסלול יכלול לקוח אחד. להתחיל מסלול?');
  });

  it('says the route will be empty when no customer is in the round', () => {
    expect(buildRouteQuestion(0)).toBe('אין לקוחות בסבב, המסלול יהיה ריק. להתחיל מסלול?');
  });
});
