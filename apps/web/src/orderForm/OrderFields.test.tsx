import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FormErrors, OrderFormField, OrderFormValues } from './formValues.ts';
import { OrderFields } from './OrderFields.tsx';

/** A form filled in with valid values, with `overrides` on top. */
function makeValues(overrides: Partial<OrderFormValues> = {}): OrderFormValues {
  return {
    name: 'משה כהן',
    phone: '050-1234567',
    street: { kind: 'listed', code: 247, name: 'דרך רבין יצחק' },
    houseNumber: '12א',
    bottlesSpot: 'privateHouse',
    floorApt: '',
    note: 'ליד השער',
    bottlesEstimated: '45',
    website: '',
    ...overrides,
  };
}

/** One call of `onFieldChange`: the field and the value it was given. */
type FieldChange = [OrderFormField, OrderFormValues[OrderFormField]];

/**
 * Renders the fields with `values` and `errors`, and an `onFieldChange` that records each call.
 * The values are not updated: the test looks at what the fields report, not at a page's state.
 */
function renderFields(
  values: OrderFormValues = makeValues(),
  errors: FormErrors['byField'] = {},
): { changes: FieldChange[]; container: HTMLElement } {
  const changes: FieldChange[] = [];
  const { container } = render(
    <OrderFields
      values={values}
      errors={errors}
      onFieldChange={(field, value) => changes.push([field, value])}
    />,
  );
  return { changes, container };
}

/** The input labelled `label`. */
function input(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

/** The text of everything `element` is described by (aria-describedby): its hint and error. */
function descriptionOf(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

describe('OrderFields', () => {
  it('shows every field with its value', () => {
    renderFields();

    expect(input('שם').value).toBe('משה כהן');
    expect(input('טלפון נייד').value).toBe('050-1234567');
    expect(input('רחוב').value).toBe('דרך רבין יצחק');
    expect(input('מספר בית').value).toBe('12א');
    expect(screen.getByRole('group', { name: 'איפה הבקבוקים' })).toBeDefined();
    expect(input('בכניסה לבית פרטי').checked).toBe(true);
    expect(input('בבניין - ליד דלת הדירה').checked).toBe(false);
    expect(input('הערה (לא חובה)').value).toBe('ליד השער');
    expect(input('כמות בקבוקים').value).toBe('45');
  });

  it('renders only the fields: no form, honeypot or submit button, which the page owns', () => {
    const { container } = renderFields();

    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input[name="website"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'שליחת הזמנה' })).toBeNull();
  });

  it('asks for the floor and apartment only when the bottles wait at the apartment door', () => {
    renderFields(makeValues({ bottlesSpot: 'buildingEntrance', floorApt: 'קומה 3' }));
    expect(screen.queryByLabelText('קומה ודירה')).toBeNull();
  });

  it('shows the floor and apartment, with its hint, for the apartment door', () => {
    renderFields(makeValues({ bottlesSpot: 'apartmentDoor', floorApt: 'קומה 3, דירה 12' }));

    expect(input('בבניין - ליד דלת הדירה').checked).toBe(true);
    expect(input('קומה ודירה').value).toBe('קומה 3, דירה 12');
    expect(descriptionOf(input('קומה ודירה'))).toBe("למשל: כניסה ב', קומה 3, דירה 12");
  });

  it('reports each change with its field and the new value', () => {
    const { changes } = renderFields(makeValues({ street: null }));

    fireEvent.change(input('שם'), { target: { value: 'רחל לוי' } });
    fireEvent.change(input('טלפון נייד'), { target: { value: '052-7654321' } });
    fireEvent.change(input('מספר בית'), { target: { value: '7' } });
    fireEvent.click(input('למטה בכניסה לבניין'));
    fireEvent.change(input('הערה (לא חובה)'), { target: { value: 'קוד 1234' } });
    fireEvent.change(input('כמות בקבוקים'), { target: { value: '60' } });
    fireEvent.change(input('רחוב'), { target: { value: 'רבין' } });
    fireEvent.click(screen.getByRole('button', { name: 'דרך רבין יצחק' }));

    expect(changes).toEqual([
      ['name', 'רחל לוי'],
      ['phone', '052-7654321'],
      ['houseNumber', '7'],
      ['bottlesSpot', 'buildingEntrance'],
      ['note', 'קוד 1234'],
      ['bottlesEstimated', '60'],
      ['street', { kind: 'listed', code: 247, name: 'דרך רבין יצחק' }],
    ]);
  });

  it('reports a change of the floor and apartment', () => {
    const { changes } = renderFields(makeValues({ bottlesSpot: 'apartmentDoor' }));

    fireEvent.change(input('קומה ודירה'), { target: { value: 'קומה 2' } });

    expect(changes).toEqual([['floorApt', 'קומה 2']]);
  });

  it('lets a street be written by hand', () => {
    const { changes } = renderFields(makeValues({ street: null }));

    fireEvent.click(screen.getByRole('button', { name: 'הרחוב שלי לא ברשימה' }));

    expect(changes).toEqual([['street', { kind: 'freeText', name: '' }]]);
  });

  it('shows an error next to its field and marks only that field invalid', () => {
    renderFields(makeValues(), {
      phone: 'מספר נייד לא תקין',
      bottlesSpot: 'נא לבחור איפה הבקבוקים',
    });

    const phone = input('טלפון נייד');
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionOf(phone)).toContain('מספר נייד לא תקין');
    const spots = screen.getByRole('group', { name: 'איפה הבקבוקים' });
    expect(descriptionOf(spots)).toBe('נא לבחור איפה הבקבוקים');
    expect(input('בכניסה לבית פרטי').getAttribute('aria-invalid')).toBe('true');
    expect(input('שם').getAttribute('aria-invalid')).toBeNull();
    expect(input('כמות בקבוקים').getAttribute('aria-invalid')).toBeNull();
  });

  it('shows the hints of the phone and the number of bottles', () => {
    renderFields();

    expect(descriptionOf(input('טלפון נייד'))).toBe('למשל 050-1234567');
    expect(descriptionOf(input('כמות בקבוקים'))).toBe('לפחות 20 בקבוקים');
  });

  describe('without the contact (the customer\'s "שינוי")', () => {
    function renderWithoutContact(): void {
      render(
        <OrderFields
          values={makeValues({ bottlesSpot: 'apartmentDoor', floorApt: 'קומה 3' })}
          errors={{}}
          onFieldChange={() => undefined}
          showContact={false}
        />,
      );
    }

    it('leaves out the name and the phone', () => {
      renderWithoutContact();

      expect(screen.queryByLabelText('שם')).toBeNull();
      expect(screen.queryByLabelText('טלפון נייד')).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'שם' })).toBeNull();
      expect(document.querySelector('input[type="tel"]')).toBeNull();
    });

    it('shows every other field with its value', () => {
      renderWithoutContact();

      expect(input('רחוב').value).toBe('דרך רבין יצחק');
      expect(input('מספר בית').value).toBe('12א');
      expect(input('בבניין - ליד דלת הדירה').checked).toBe(true);
      expect(input('קומה ודירה').value).toBe('קומה 3');
      expect(input('הערה (לא חובה)').value).toBe('ליד השער');
      expect(input('כמות בקבוקים').value).toBe('45');
    });
  });
});
