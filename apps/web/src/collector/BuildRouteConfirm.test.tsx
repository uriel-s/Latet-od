// The question's words. The component itself is tested through the rounds screen
// (RoundsScreen.test.tsx, "סגור אישורים ובנה מסלול"), which owns its request and its guard.
import { describe, expect, it } from 'vitest';
import { buildRouteQuestion } from './BuildRouteConfirm.tsx';

describe('buildRouteQuestion', () => {
  it('says how many customers who did not confirm go back to waiting', () => {
    expect(buildRouteQuestion(3)).toBe(
      '3 לקוחות שעוד לא אישרו יחזרו לחכות לסבב הבא. לסגור את האישורים ולבנות מסלול?',
    );
  });

  it('says it of one customer in the singular', () => {
    expect(buildRouteQuestion(1)).toBe(
      'לקוח אחד שעוד לא אישר יחזור לחכות לסבב הבא. לסגור את האישורים ולבנות מסלול?',
    );
  });

  it('says no one goes back to waiting when no one is pending', () => {
    expect(buildRouteQuestion(0)).toBe('אף לקוח לא יחזור לחכות. לסגור את האישורים ולבנות מסלול?');
  });
});
