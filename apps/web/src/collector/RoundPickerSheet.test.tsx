import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollectorRound, RoundView } from '@bottlerun/shared';
import { RoundPicker } from './RoundPickerSheet.tsx';

/** A round's view with no orders and no stops; the picker only reads the round and the counts. */
function makeRoundView(overrides: Partial<CollectorRound> = {}): RoundView {
  return {
    round: {
      id: 'r1',
      date: '2026-10-28',
      region: 'ramat',
      status: 'open',
      phase: 'confirming',
      createdAt: new Date('2026-10-20T07:00:00Z'),
      ...overrides,
    },
    groups: [
      { key: 'confirmed', orders: [] },
      { key: 'pending', orders: [] },
      { key: 'otherDate', orders: [] },
    ],
    sendList: [],
    stops: [],
  };
}

const RAMAT_1 = makeRoundView({ id: 'a', date: '2026-10-28', region: 'ramat' });
const OLD_1 = makeRoundView({ id: 'b', date: '2026-10-29', region: 'old', phase: 'routed' });
const RAMAT_2 = makeRoundView({ id: 'c', date: '2026-11-02', region: 'ramat' });
const ROUNDS = [RAMAT_1, OLD_1, RAMAT_2];

/** The picker inside a tiny screen that keeps the selection, like RoundsScreen does. */
function Harness({
  rounds,
  onSelect,
}: {
  rounds: readonly RoundView[];
  onSelect?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(rounds[0]?.round.id ?? '');
  return (
    <RoundPicker
      rounds={rounds}
      selectedId={selectedId}
      onSelect={(id) => {
        onSelect?.(id);
        setSelectedId(id);
      }}
    />
  );
}

/** The button that opens the sheet: the only button with `aria-haspopup`, open or closed. */
function trigger(): HTMLElement {
  const [button, ...others] = screen
    .getAllByRole('button')
    .filter((candidate) => candidate.getAttribute('aria-haspopup') === 'dialog');
  expect(others).toHaveLength(0);
  return button as HTMLElement;
}

function openSheet(): HTMLElement {
  fireEvent.click(trigger());
  return screen.getByRole('dialog', { name: 'בחירת סבב' });
}

/** The row buttons of the open sheet. */
function rows(dialog: HTMLElement): HTMLElement[] {
  return within(within(dialog).getByRole('list')).getAllByRole('button');
}

describe('RoundPicker', () => {
  it('renders nothing for no round and for a single round', () => {
    const { container, rerender } = render(
      <RoundPicker rounds={[]} selectedId="" onSelect={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(<RoundPicker rounds={[RAMAT_1]} selectedId="a" onSelect={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('releases the scroll lock and stays closed when the rounds drop below two while open', () => {
    const { container, rerender } = render(
      <RoundPicker rounds={ROUNDS} selectedId="a" onSelect={vi.fn()} />,
    );
    openSheet();
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<RoundPicker rounds={[RAMAT_1]} selectedId="a" onSelect={vi.fn()} />);
    expect(container.innerHTML).toBe('');
    expect(document.body.style.overflow).toBe('');

    // A second round showing up again must not bring the old sheet back by itself.
    rerender(<RoundPicker rounds={ROUNDS} selectedId="a" onSelect={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('starts the button text with what it chooses, so the date does not stand alone', () => {
    render(<Harness rounds={ROUNDS} />);
    expect(trigger().textContent?.startsWith('סבב: 28/10')).toBe(true);
  });

  it('shows the selected round on the button, with the sheet closed', () => {
    render(<Harness rounds={ROUNDS} />);
    const button = trigger();
    expect(button.textContent).toContain('28/10 · רמת בית שמש · אישרו 0 מתוך 0');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a named dialog with a row per round and marks the selected one', () => {
    render(<Harness rounds={ROUNDS} />);
    const dialog = openSheet();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    const list = rows(dialog);
    expect(list).toHaveLength(3);
    expect(list[0]?.getAttribute('aria-current')).toBe('true');
    expect(list[1]?.getAttribute('aria-current')).toBeNull();
    expect(list[0]?.textContent).toContain('אישורים');
    expect(list[1]?.textContent).toContain('29/10 · בית שמש · 0 עצירות');
    expect(list[1]?.textContent).toContain('מסלול');
  });

  it('calls onSelect with the chosen id, closes the sheet and returns the focus to the button', () => {
    const onSelect = vi.fn();
    render(<Harness rounds={ROUNDS} onSelect={onSelect} />);
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: /29\/10/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger().textContent).toContain('29/10 · בית שמש');
    expect(document.activeElement).toBe(trigger());
  });

  it('filters the rows with a region chip and toggles aria-pressed', () => {
    render(<Harness rounds={ROUNDS} />);
    const dialog = openSheet();
    const all = within(dialog).getByRole('button', { name: 'הכל' });
    const ramat = within(dialog).getByRole('button', { name: 'רמת בית שמש' });
    const old = within(dialog).getByRole('button', { name: 'בית שמש' });
    expect(all.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(old);
    expect(old.getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');
    expect(rows(dialog)).toHaveLength(1);

    fireEvent.click(ramat);
    expect(rows(dialog)).toHaveLength(2);

    fireEvent.click(all);
    expect(rows(dialog)).toHaveLength(3);
  });

  it('hides the chips when the rounds are all in one region', () => {
    render(<Harness rounds={[RAMAT_1, RAMAT_2]} />);
    const dialog = openSheet();
    expect(within(dialog).queryByRole('button', { name: 'הכל' })).toBeNull();
    expect(rows(dialog)).toHaveLength(2);
  });

  it('shows every round again when the remembered region no longer has a round', () => {
    const { rerender } = render(<RoundPicker rounds={ROUNDS} selectedId="a" onSelect={vi.fn()} />);
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'בית שמש' }));
    // The only round of the old city was closed meanwhile.
    rerender(<RoundPicker rounds={[RAMAT_1, RAMAT_2]} selectedId="a" onSelect={vi.fn()} />);
    expect(rows(screen.getByRole('dialog'))).toHaveLength(2);
  });

  it('closes on Escape and returns the focus to the button', () => {
    render(<Harness rounds={ROUNDS} />);
    fireEvent.keyDown(openSheet(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes with "סגור" without choosing', () => {
    const onSelect = vi.fn();
    render(<Harness rounds={ROUNDS} onSelect={onSelect} />);
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'סגור' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a tap on the dark background', () => {
    const onSelect = vi.fn();
    const { container } = render(<Harness rounds={ROUNDS} onSelect={onSelect} />);
    openSheet();
    // The backdrop is a decorative veil with no role, so it is the one thing found by class.
    const backdrop = container.querySelector('.round-picker-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the sheet by wrapping from the last control to the first and back', () => {
    render(<Harness rounds={ROUNDS} />);
    const dialog = openSheet();
    const close = within(dialog).getByRole('button', { name: 'סגור' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'הכל' }));

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it('does not scroll the page behind while open', () => {
    render(<Harness rounds={ROUNDS} />);
    const dialog = openSheet();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(dialog).getByRole('button', { name: 'סגור' }));
    expect(document.body.style.overflow).toBe('');
  });
});
