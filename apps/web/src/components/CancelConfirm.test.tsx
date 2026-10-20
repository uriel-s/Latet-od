import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CancelConfirm, type CancelConfirmProps } from './CancelConfirm.tsx';

/** Renders the component with cancel's words; returns how many times "confirm" was tapped. */
function renderConfirm(overrides: Partial<CancelConfirmProps> = {}): { confirms: () => number } {
  const onConfirm = vi.fn();
  render(
    <CancelConfirm
      buttonLabel="ביטול ההזמנה"
      question="לבטל את ההזמנה?"
      cancelling={false}
      error={null}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { confirms: () => onConfirm.mock.calls.length };
}

function open(buttonLabel: string): void {
  fireEvent.click(screen.getByRole('button', { name: buttonLabel }));
}

describe('CancelConfirm', () => {
  it('asks first, and sends nothing until the confirming answer', () => {
    const { confirms } = renderConfirm();

    open('ביטול ההזמנה');
    expect(screen.getByRole('group', { name: 'לבטל את ההזמנה?' })).toBeDefined();
    expect(confirms()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'כן, לבטל' }));
    expect(confirms()).toBe(1);
  });

  it('says "מבטל..." on the confirming button while the cancel is on its way', () => {
    renderConfirm({ cancelling: true });
    open('ביטול ההזמנה');

    const busy = screen.getByRole('button', { name: 'מבטל...' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
  });

  it('uses the words the screen gives it, for a question that is not a cancel', () => {
    const { confirms } = renderConfirm({
      buttonLabel: 'לא מתאים הפעם',
      question: 'לא מתאים לך הפעם?',
      confirmLabel: 'כן, לא מתאים',
      busyLabel: 'שולח...',
    });
    open('לא מתאים הפעם');

    fireEvent.click(screen.getByRole('button', { name: 'כן, לא מתאים' }));
    expect(confirms()).toBe(1);
    expect(screen.queryByRole('button', { name: 'כן, לבטל' })).toBeNull();
  });

  it('says the screen own busy word on the confirming button while it is on its way', () => {
    renderConfirm({ cancelling: true, confirmLabel: 'כן, לא מתאים', busyLabel: 'שולח...' });
    open('ביטול ההזמנה');

    expect(screen.getByRole('button', { name: 'שולח...' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'מבטל...' })).toBeNull();
  });

  it('shows why the last try failed inside the question', () => {
    renderConfirm({ error: 'לא הצלחנו' });
    open('ביטול ההזמנה');

    expect(screen.getByRole('alert').textContent).toBe('לא הצלחנו');
  });
});
