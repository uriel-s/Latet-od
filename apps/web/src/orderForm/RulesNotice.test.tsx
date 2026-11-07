import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RulesNotice } from './RulesNotice.tsx';

describe('RulesNotice', () => {
  it('shows the three rules of accepted bottles in Hebrew, in order', () => {
    render(<RulesNotice lang="he" onAccept={() => undefined} />);

    expect(screen.getByRole('heading', { level: 1, name: 'שימו לב!' })).toBeDefined();
    expect(screen.getByText('אנו מקבלים:')).toBeDefined();
    const items = within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'בקבוקים שרשום עליהם פיקדון 30 אגורות',
      'בקבוקים ריקים ואין בהם זבל או נוזל',
      'להכין את הבקבוקים בשקית בלבד סגורה וקשורה.',
    ]);
    expect(screen.getByText('תודה, לתת עוד')).toBeDefined();
    expect(screen.getByRole('button', { name: 'הבנתי, להזמנה' })).toBeDefined();
  });

  it('shows the same notice in English', () => {
    render(<RulesNotice lang="en" onAccept={() => undefined} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Please note!' })).toBeDefined();
    expect(screen.getByText('We accept:')).toBeDefined();
    const items = within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'Bottles marked with a 30-agorot deposit',
      'Empty bottles, with no trash or liquid inside',
      'Bottles packed only in a closed, tied bag',
    ]);
    expect(screen.getByText('Thank you. Latet Od')).toBeDefined();
    expect(screen.getByRole('button', { name: 'I understand, continue' })).toBeDefined();
  });

  it('calls onAccept when the button is pressed, and not before', () => {
    const onAccept = vi.fn();
    render(<RulesNotice lang="he" onAccept={onAccept} />);
    expect(onAccept).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'הבנתי, להזמנה' }));

    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('has a plain button, so it never submits a form around it', () => {
    render(<RulesNotice lang="he" onAccept={() => undefined} />);

    expect(screen.getByRole('button', { name: 'הבנתי, להזמנה' }).getAttribute('type')).toBe(
      'button',
    );
  });
});
