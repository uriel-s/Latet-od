import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { Street } from '@bottlerun/shared';
import { MAX_STREET_RESULTS, StreetPicker, type StreetPickerProps } from './StreetPicker.tsx';
import type { StreetChoice } from './streetChoice.ts';

type PickerOptions = Partial<Omit<StreetPickerProps, 'value' | 'onChange'>> & {
  initialValue?: StreetChoice | null;
};

/**
 * Renders the picker the way a form does: the value lives in the parent's state. Returns every
 * value passed to onChange, in order.
 */
function renderPicker({ initialValue = null, ...props }: PickerOptions = {}): {
  changes: (StreetChoice | null)[];
} {
  const changes: (StreetChoice | null)[] = [];
  function Parent() {
    const [value, setValue] = useState<StreetChoice | null>(initialValue);
    return (
      <StreetPicker
        label="רחוב"
        {...props}
        value={value}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Parent />);
  return { changes };
}

/** The input labelled `label`, typed into as a customer would. */
function typeInto(label: string, text: string): HTMLInputElement {
  const input = screen.getByLabelText<HTMLInputElement>(label);
  fireEvent.change(input, { target: { value: text } });
  return input;
}

/** `count` streets that all match the query "הדקל". */
function manyStreets(count: number): Street[] {
  return Array.from({ length: count }, (_, index) => ({
    code: index + 1,
    name: `הדקל ${index + 1}`,
  }));
}

describe('StreetPicker search', () => {
  it('shows the official street for a word of its name and chooses it on tap', () => {
    const { changes } = renderPicker();

    const input = typeInto('רחוב', 'רבין');
    fireEvent.click(screen.getByRole('button', { name: 'דרך רבין יצחק' }));

    expect(changes).toEqual([{ kind: 'listed', code: 247, name: 'דרך רבין יצחק' }]);
    expect(input.value).toBe('דרך רבין יצחק');
    // The list closes once the chosen street is in the input.
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: 'דרך רבין יצחק' })).toBeNull();
  });

  it('clears the choice when the text is edited after a choice, and searches again', () => {
    const { changes } = renderPicker();
    typeInto('רחוב', 'רבין');
    fireEvent.click(screen.getByRole('button', { name: 'דרך רבין יצחק' }));

    typeInto('רחוב', 'דרך רבין');

    expect(changes.at(-1)).toBeNull();
    expect(screen.getByRole('button', { name: 'דרך רבין יצחק' })).toBeDefined();
  });

  it('does not call onChange while typing with nothing chosen', () => {
    const { changes } = renderPicker();

    typeInto('רחוב', 'ר');
    typeInto('רחוב', 'רב');

    expect(changes).toEqual([]);
  });

  it('shows no list and no message for an empty query', () => {
    renderPicker();

    expect(screen.queryByRole('list')).toBeNull();

    typeInto('רחוב', 'רבין');
    typeInto('רחוב', '   ');

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/לא מצאנו/)).toBeNull();
  });

  it('says so in plain words when no street matches, and points to free text', () => {
    renderPicker();

    typeInto('רחוב', 'אין רחוב כזה בכלל');

    expect(screen.queryByRole('list')).toBeNull();
    const notFound = screen.getByText(/לא מצאנו רחוב בשם הזה\./);
    expect(notFound.textContent).toContain('הרחוב שלי לא ברשימה');
  });

  it(`shows at most ${MAX_STREET_RESULTS} streets and asks to keep typing when there are more`, () => {
    renderPicker({ streets: manyStreets(12) });

    typeInto('רחוב', 'הדקל');

    const list = screen.getByRole('list', { name: 'רחובות שמתאימים לחיפוש' });
    expect(within(list).getAllByRole('button')).toHaveLength(MAX_STREET_RESULTS);
    expect(MAX_STREET_RESULTS).toBe(8);
    expect(screen.getByText(/נא להמשיך לכתוב את השם/)).toBeDefined();
  });

  it('says how many streets it found', () => {
    renderPicker({ streets: manyStreets(3) });

    typeInto('רחוב', 'הדקל');

    expect(screen.getByText('נמצאו 3 רחובות. נא ללחוץ על הרחוב הנכון.')).toBeDefined();
  });

  it('searches only the streets it is given', () => {
    const { changes } = renderPicker({ streets: manyStreets(3) });

    typeInto('רחוב', 'רבין');
    expect(screen.getByText(/לא מצאנו רחוב בשם הזה\./)).toBeDefined();

    typeInto('רחוב', 'הדקל 2');
    fireEvent.click(screen.getByRole('button', { name: 'הדקל 2' }));
    expect(changes).toEqual([{ kind: 'listed', code: 2, name: 'הדקל 2' }]);
  });
});

describe('StreetPicker free text', () => {
  it('switches to a free-text input with what was typed, trimmed, and focuses it', () => {
    const { changes } = renderPicker();
    typeInto('רחוב', '  הרחוב החדש  ');

    fireEvent.click(screen.getByRole('button', { name: 'הרחוב שלי לא ברשימה' }));

    expect(changes).toEqual([{ kind: 'freeText', name: 'הרחוב החדש' }]);
    const input = screen.getByLabelText<HTMLInputElement>('שם הרחוב');
    expect(input.value).toBe('הרחוב החדש');
    expect(input.maxLength).toBe(60);
    expect(document.activeElement).toBe(input);
    // One input at a time: the search input is gone, and so is its list and its button.
    expect(screen.queryByLabelText('רחוב')).toBeNull();
    expect(screen.queryByRole('button', { name: 'הרחוב שלי לא ברשימה' })).toBeNull();
  });

  it('passes every keystroke in free text to onChange', () => {
    const { changes } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'הרחוב שלי לא ברשימה' }));

    typeInto('שם הרחוב', 'הגפן');

    expect(changes).toEqual([
      { kind: 'freeText', name: '' },
      { kind: 'freeText', name: 'הגפן' },
    ]);
  });

  it('goes back to the street list with onChange(null) and focuses the search input', () => {
    const { changes } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'הרחוב שלי לא ברשימה' }));
    typeInto('שם הרחוב', 'רבין');

    fireEvent.click(screen.getByRole('button', { name: 'חזרה לרשימת הרחובות' }));

    expect(changes.at(-1)).toBeNull();
    const input = screen.getByLabelText<HTMLInputElement>('רחוב');
    expect(document.activeElement).toBe(input);
    // What was written by hand searches the list again.
    expect(input.value).toBe('רבין');
    expect(screen.getByRole('button', { name: 'דרך רבין יצחק' })).toBeDefined();
  });

  it('offers no free text when allowFreeText is false (Yoel\'s "רחוב קרוב")', () => {
    renderPicker({ label: 'רחוב קרוב', allowFreeText: false });

    typeInto('רחוב קרוב', 'אין רחוב כזה בכלל');

    expect(screen.queryByRole('button', { name: 'הרחוב שלי לא ברשימה' })).toBeNull();
    expect(screen.getByText(/לא מצאנו רחוב בשם הזה\./).textContent).not.toContain(
      'הרחוב שלי לא ברשימה',
    );
  });
});

describe('StreetPicker initial value', () => {
  it('starts with a listed street in the input and no list', () => {
    const { changes } = renderPicker({
      initialValue: { kind: 'listed', code: 247, name: 'דרך רבין יצחק' },
    });

    expect(screen.getByLabelText<HTMLInputElement>('רחוב').value).toBe('דרך רבין יצחק');
    expect(screen.queryByRole('list')).toBeNull();
    expect(changes).toEqual([]);
  });

  it('starts in free-text mode with a street written by hand', () => {
    const { changes } = renderPicker({ initialValue: { kind: 'freeText', name: 'הגפן' } });

    expect(screen.getByLabelText<HTMLInputElement>('שם הרחוב').value).toBe('הגפן');
    expect(screen.getByRole('button', { name: 'חזרה לרשימת הרחובות' })).toBeDefined();
    expect(changes).toEqual([]);
  });
});

describe('StreetPicker error', () => {
  it('shows the error next to the field and links it to the input', () => {
    renderPicker({ error: 'נא לבחור רחוב או לכתוב אותו' });

    const input = screen.getByLabelText('רחוב');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errorId = input.getAttribute('aria-describedby');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? '')?.textContent).toBe('נא לבחור רחוב או לכתוב אותו');
  });

  it('keeps the error linked in free-text mode', () => {
    renderPicker({ error: 'שם הרחוב ארוך מדי' });
    fireEvent.click(screen.getByRole('button', { name: 'הרחוב שלי לא ברשימה' }));

    const input = screen.getByLabelText('שם הרחוב');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'שם הרחוב ארוך מדי',
    );
  });

  it('marks nothing invalid without an error', () => {
    renderPicker();

    const input = screen.getByLabelText('רחוב');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('StreetPicker hint', () => {
  /** The text of everything `element` is described by (aria-describedby), in order. */
  function descriptions(element: HTMLElement): string[] {
    return (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id)?.textContent ?? '');
  }

  it('shows the hint and links it to the input', () => {
    renderPicker({ label: 'רחוב קרוב', allowFreeText: false, hint: 'רחוב קרוב קובע את האזור.' });

    expect(screen.getByText('רחוב קרוב קובע את האזור.')).toBeDefined();
    expect(descriptions(screen.getByLabelText('רחוב קרוב'))).toEqual(['רחוב קרוב קובע את האזור.']);
  });

  it('links both the hint and the error, the hint first', () => {
    renderPicker({ hint: 'למשל: הרצל', error: 'נא לבחור רחוב או לכתוב אותו' });

    const input = screen.getByLabelText('רחוב');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(descriptions(input)).toEqual(['למשל: הרצל', 'נא לבחור רחוב או לכתוב אותו']);
  });
});
