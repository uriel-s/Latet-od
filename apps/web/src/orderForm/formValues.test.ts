import { describe, expect, it } from 'vitest';
import { ORDER_FORM_ERRORS, orderFormSchema } from '@bottlerun/shared';
import {
  UNKNOWN_FIELD_ERROR,
  emptyOrderFormValues,
  mapFieldErrors,
  validateOrderForm,
  type OrderFormValues,
} from './formValues.ts';

/** Street 247 of the official list. */
const RABIN = { kind: 'listed', code: 247, name: 'דרך רבין יצחק' } as const;

/** A form a customer filled in correctly, with `overrides` on top. */
function makeValues(overrides: Partial<OrderFormValues> = {}): OrderFormValues {
  return {
    name: 'משה כהן',
    phone: '050-1234567',
    street: RABIN,
    houseNumber: '12',
    bottlesSpot: 'privateHouse',
    floorApt: '',
    note: '',
    bottlesEstimated: '45',
    website: '',
    ...overrides,
  };
}

/** The request of values that must validate; fails the test otherwise. */
function requestOf(values: OrderFormValues) {
  const result = validateOrderForm(values);
  if (!result.ok) throw new Error(`expected valid values, got ${JSON.stringify(result.errors)}`);
  return result.request;
}

/** The errors of values that must not validate; fails the test otherwise. */
function errorsOf(values: OrderFormValues) {
  const result = validateOrderForm(values);
  if (result.ok) throw new Error('expected invalid values');
  return result.errors;
}

describe('emptyOrderFormValues', () => {
  it('returns a blank form with no street and no spot chosen', () => {
    expect(emptyOrderFormValues()).toEqual({
      name: '',
      phone: '',
      street: null,
      houseNumber: '',
      bottlesSpot: '',
      floorApt: '',
      note: '',
      bottlesEstimated: '',
      website: '',
    });
  });

  it('returns a new object each time', () => {
    expect(emptyOrderFormValues()).not.toBe(emptyOrderFormValues());
  });
});

describe('validateOrderForm', () => {
  it('builds the request from valid values: E.164 phone, official street, number of bottles', () => {
    expect(validateOrderForm(makeValues({ name: '  משה כהן ' }))).toEqual({
      ok: true,
      request: {
        contact: { name: 'משה כהן', phone: '+972501234567' },
        address: {
          streetCode: 247,
          streetName: 'דרך רבין יצחק',
          houseNumber: '12',
          bottlesSpot: 'privateHouse',
        },
        bottlesEstimated: 45,
        website: '',
      },
    });
  });

  it('sends a listed street as its code with the official name, whatever name the picker held', () => {
    const request = requestOf(makeValues({ street: { kind: 'listed', code: 247, name: 'רבין' } }));
    expect(request.address.streetCode).toBe(247);
    expect(request.address.streetName).toBe('דרך רבין יצחק');
  });

  it('sends a street written by hand as its name only, with no code', () => {
    const request = requestOf(makeValues({ street: { kind: 'freeText', name: ' הנרקיס ' } }));
    expect(request.address.streetName).toBe('הנרקיס');
    expect(request.address).not.toHaveProperty('streetCode');
  });

  it('asks for a street when none was chosen', () => {
    expect(errorsOf(makeValues({ street: null }))).toEqual({
      byField: { street: ORDER_FORM_ERRORS.streetRequired },
    });
  });

  it('asks for a street when the street written by hand is blank', () => {
    const errors = errorsOf(makeValues({ street: { kind: 'freeText', name: '   ' } }));
    expect(errors.byField.street).toBe(ORDER_FORM_ERRORS.streetRequired);
  });

  it('rejects fewer than 30 bottles next to the bottles field', () => {
    expect(errorsOf(makeValues({ bottlesEstimated: '29' }))).toEqual({
      byField: { bottlesEstimated: 'צריך לפחות 30 בקבוקים' },
    });
  });

  it('accepts exactly 30 bottles', () => {
    expect(requestOf(makeValues({ bottlesEstimated: '30' })).bottlesEstimated).toBe(30);
  });

  it('asks where the bottles are when no spot was chosen', () => {
    expect(errorsOf(makeValues({ bottlesSpot: '' })).byField.bottlesSpot).toBe(
      'נא לבחור איפה הבקבוקים',
    );
  });

  it('asks for the floor and apartment when the bottles wait at the apartment door', () => {
    expect(errorsOf(makeValues({ bottlesSpot: 'apartmentDoor', floorApt: ' ' }))).toEqual({
      byField: { floorApt: 'נא לכתוב קומה ודירה' },
    });
  });

  it('sends the floor and apartment when the bottles wait at the apartment door', () => {
    const request = requestOf(makeValues({ bottlesSpot: 'apartmentDoor', floorApt: 'קומה 3' }));
    expect(request.address.floorApt).toBe('קומה 3');
  });

  it('does not send floor and apartment text left over when another spot is chosen', () => {
    for (const bottlesSpot of ['privateHouse', 'buildingEntrance'] as const) {
      const request = requestOf(makeValues({ bottlesSpot, floorApt: 'קומה 3, דירה 12' }));
      expect(request.address, bottlesSpot).not.toHaveProperty('floorApt');
    }
  });

  it('sends a note, trimmed, and leaves out a blank one', () => {
    expect(requestOf(makeValues({ note: ' ליד השער ' })).address.note).toBe('ליד השער');
    expect(requestOf(makeValues({ note: '  ' })).address).not.toHaveProperty('note');
  });

  it('rejects an invalid phone next to the phone field', () => {
    expect(errorsOf(makeValues({ phone: '02-9912345' })).byField).toEqual({
      phone: 'מספר נייד לא תקין. למשל: 050-1234567',
    });
  });

  it('shows every mistake of a blank form at once, each next to its field', () => {
    expect(errorsOf(emptyOrderFormValues())).toEqual({
      byField: {
        name: ORDER_FORM_ERRORS.nameRequired,
        phone: 'מספר נייד לא תקין. למשל: 050-1234567',
        street: ORDER_FORM_ERRORS.streetRequired,
        houseNumber: ORDER_FORM_ERRORS.houseNumberRequired,
        bottlesSpot: ORDER_FORM_ERRORS.bottlesSpotRequired,
        bottlesEstimated: ORDER_FORM_ERRORS.bottlesRequired,
      },
    });
  });

  it('sends the honeypot exactly as the hidden input holds it', () => {
    expect(requestOf(makeValues({ website: 'http://spam.example' })).website).toBe(
      'http://spam.example',
    );
  });

  it('builds a request that the shared schema accepts again unchanged', () => {
    const { website, ...form } = requestOf(
      makeValues({ bottlesSpot: 'apartmentDoor', floorApt: 'קומה 3', note: 'קוד 1234' }),
    );
    expect(website).toBe('');
    expect(orderFormSchema.parse(form)).toEqual(form);
  });
});

describe('mapFieldErrors', () => {
  it('maps every dotted path of the schema to its form field', () => {
    expect(
      mapFieldErrors({
        'contact.name': 'a',
        'contact.phone': 'b',
        'address.streetName': 'c',
        'address.houseNumber': 'd',
        'address.bottlesSpot': 'e',
        'address.floorApt': 'f',
        'address.note': 'g',
        bottlesEstimated: 'h',
      }),
    ).toEqual({
      byField: {
        name: 'a',
        phone: 'b',
        street: 'c',
        houseNumber: 'd',
        bottlesSpot: 'e',
        floorApt: 'f',
        note: 'g',
        bottlesEstimated: 'h',
      },
    });
  });

  it('shows one message for the street when both of its paths failed: the first one', () => {
    expect(
      mapFieldErrors({ 'address.streetCode': 'הרחוב לא נמצא', 'address.streetName': 'אחר' }),
    ).toEqual({ byField: { street: 'הרחוב לא נמצא' } });
  });

  it('keeps an unknown path as a message above the form, next to the known ones', () => {
    expect(mapFieldErrors({ 'contact.name': 'נא לכתוב שם', 'address.city': 'x' })).toEqual({
      byField: { name: 'נא לכתוב שם' },
      other: UNKNOWN_FIELD_ERROR,
    });
  });

  it('keeps an error about a whole group, such as contact, as a message above the form', () => {
    expect(mapFieldErrors({ contact: 'Invalid input' })).toEqual({
      byField: {},
      other: UNKNOWN_FIELD_ERROR,
    });
  });

  it('still says something for a failure with no field at all', () => {
    expect(mapFieldErrors({})).toEqual({ byField: {}, other: UNKNOWN_FIELD_ERROR });
  });

  it('treats a __proto__ key as an unknown path, without touching any prototype', () => {
    const fieldErrors = JSON.parse(
      '{"__proto__": {"polluted": "yes"}, "constructor": "x", "contact.phone": "טלפון"}',
    ) as Record<string, string>;
    const errors = mapFieldErrors(fieldErrors);
    expect(errors).toEqual({ byField: { phone: 'טלפון' }, other: UNKNOWN_FIELD_ERROR });
    expect(Object.getPrototypeOf(errors.byField)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
