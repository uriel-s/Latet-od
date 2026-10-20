import { describe, expect, it } from 'vitest';
import {
  CREATE_ORDER_MESSAGES,
  COLLECTOR_ORDER_MESSAGES,
  STREETS,
  type AddOrderRequest,
  type CollectorOrder,
  type Street,
} from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR } from '../orderForm/formValues.ts';
import {
  CANCEL_FAILED_MESSAGE,
  SAVE_FAILED_MESSAGE,
  cancelErrorMessage,
  editRequest,
  formValuesFromOrder,
  nearStreetChoice,
  saveErrors,
} from './orderEditing.ts';

/** The first street of the shared list in `region`: a real code and its official name. */
function streetIn(region: 'ramat' | 'old'): Street {
  const street = STREETS.find((candidate) => candidate.region === region);
  if (street === undefined) throw new Error(`no street in ${region}`);
  return street;
}

const RAMAT_STREET = streetIn('ramat');
const OLD_STREET = streetIn('old');

/** A waiting order on a listed street in רמת בית שמש; overrides change it. */
function makeOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: RAMAT_STREET.code,
      streetName: RAMAT_STREET.name,
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3',
    },
    bottlesEstimated: 40,
    status: 'waiting',
    region: 'ramat',
    source: 'form',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    hasLocation: true,
    ...overrides,
  };
}

/** A free-text order: no street code, no region, no map point. */
function makeFreeTextOrder(overrides: Partial<CollectorOrder['address']> = {}): CollectorOrder {
  return makeOrder({
    address: {
      streetName: 'סמטת הגפנים',
      houseNumber: '7',
      bottlesSpot: 'privateHouse',
      ...overrides,
    },
    region: undefined,
    hasLocation: false,
  });
}

/** The validated form details of {@link makeOrder}, as validateOrderDetails outputs them. */
const DETAILS: AddOrderRequest = {
  contact: { name: 'דנה כהן', phone: '+972501234567' },
  address: {
    streetCode: RAMAT_STREET.code,
    streetName: RAMAT_STREET.name,
    houseNumber: '12',
    bottlesSpot: 'apartmentDoor',
    floorApt: 'קומה 3',
  },
  bottlesEstimated: 40,
};

describe('formValuesFromOrder', () => {
  it('fills the form from the order: local phone, listed street, bottles as text', () => {
    expect(formValuesFromOrder(makeOrder())).toEqual({
      name: 'דנה כהן',
      phone: '050-1234567',
      street: { kind: 'listed', code: RAMAT_STREET.code, name: RAMAT_STREET.name },
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3',
      note: '',
      bottlesEstimated: '40',
      website: '',
    });
  });

  it('keeps a street written by hand as free text, with the note', () => {
    const values = formValuesFromOrder(makeFreeTextOrder({ note: 'ליד השער' }));

    expect(values.street).toEqual({ kind: 'freeText', name: 'סמטת הגפנים' });
    expect(values.note).toBe('ליד השער');
    expect(values.floorApt).toBe('');
  });
});

describe('nearStreetChoice', () => {
  it('is the listed street of the code, by its official name', () => {
    expect(nearStreetChoice(OLD_STREET.code)).toEqual({
      kind: 'listed',
      code: OLD_STREET.code,
      name: OLD_STREET.name,
    });
  });

  it('is null without a near street', () => {
    expect(nearStreetChoice(undefined)).toBeNull();
  });

  it('is null for a code no longer in the list', () => {
    expect(nearStreetChoice(999_999)).toBeNull();
  });
});

describe('editRequest', () => {
  const ramatChoice = { kind: 'listed', code: RAMAT_STREET.code, name: RAMAT_STREET.name } as const;
  const oldChoice = { kind: 'listed', code: OLD_STREET.code, name: OLD_STREET.name } as const;

  it('always sends contact, address and bottles, and nothing else when nothing else changed', () => {
    expect(editRequest(makeOrder(), DETAILS, null, 'ramat')).toEqual({
      contact: DETAILS.contact,
      address: DETAILS.address,
      bottlesEstimated: 40,
    });
  });

  it('sends the near street picked for a free-text order, and no region', () => {
    const request = editRequest(makeFreeTextOrder(), DETAILS, oldChoice, undefined);

    expect(request.nearStreetCode).toBe(OLD_STREET.code);
    // No region key at all: the api derives it from the new near street.
    expect('region' in request).toBe(false);
  });

  it('sends no near street when it is the stored one', () => {
    const order = makeFreeTextOrder({ nearStreetCode: OLD_STREET.code });

    const request = editRequest(order, DETAILS, oldChoice, undefined);

    expect('nearStreetCode' in request).toBe(false);
  });

  it('sends another near street in place of the stored one', () => {
    const order = makeFreeTextOrder({ nearStreetCode: OLD_STREET.code });

    expect(editRequest(order, DETAILS, ramatChoice, undefined).nearStreetCode).toBe(
      RAMAT_STREET.code,
    );
  });

  it('sends null to remove a stored near street that was cleared', () => {
    const order = makeFreeTextOrder({ nearStreetCode: OLD_STREET.code });

    const request = editRequest(order, DETAILS, null, undefined);

    expect('nearStreetCode' in request).toBe(true);
    expect(request.nearStreetCode).toBeNull();
  });

  it('counts a free-text value as no near street', () => {
    const request = editRequest(
      makeFreeTextOrder(),
      DETAILS,
      { kind: 'freeText', name: 'x' },
      undefined,
    );

    expect('nearStreetCode' in request).toBe(false);
  });

  it('sends the region Yoel picked when it differs from the stored one', () => {
    expect(editRequest(makeOrder(), DETAILS, null, 'old').region).toBe('old');
  });

  it('sends the region picked for an order that had none', () => {
    expect(editRequest(makeFreeTextOrder(), DETAILS, null, 'ramat').region).toBe('ramat');
  });

  it('sends both a near street and a region picked by hand: the api lets the region win', () => {
    const request = editRequest(makeFreeTextOrder(), DETAILS, oldChoice, 'ramat');

    expect(request.nearStreetCode).toBe(OLD_STREET.code);
    expect(request.region).toBe('ramat');
  });
});

describe('saveErrors', () => {
  it("shows the api's field errors as they are", () => {
    const errors = { byField: { bottlesEstimated: 'מינימום 30 בקבוקים' } };

    expect(saveErrors({ kind: 'invalid', errors })).toBe(errors);
  });

  it('puts the duplicate message next to the phone', () => {
    const message = CREATE_ORDER_MESSAGES.duplicateOpenOrder;

    expect(saveErrors({ kind: 'duplicate', message })).toEqual({ byField: { phone: message } });
  });

  it.each([
    ['closed', COLLECTOR_ORDER_MESSAGES.orderClosed],
    ['notFound', COLLECTOR_ORDER_MESSAGES.orderNotFound],
  ] as const)('shows the %s message above the button', (kind, message) => {
    expect(saveErrors({ kind, message })).toEqual({ byField: {}, other: message });
  });

  it('asks to check the connection when the save failed', () => {
    expect(saveErrors({ kind: 'failed' })).toEqual({ byField: {}, other: SAVE_FAILED_MESSAGE });
    expect(SAVE_FAILED_MESSAGE).toBe('לא הצלחנו לשמור. נא לבדוק את החיבור לאינטרנט ולנסות שוב.');
  });
});

describe('cancelErrorMessage', () => {
  it.each([
    ['closed', COLLECTOR_ORDER_MESSAGES.orderClosed],
    ['notFound', COLLECTOR_ORDER_MESSAGES.orderNotFound],
  ] as const)('says why for %s', (kind, message) => {
    expect(cancelErrorMessage({ kind, message })).toBe(message);
  });

  it('asks to check the connection for any other answer', () => {
    expect(cancelErrorMessage({ kind: 'failed' })).toBe(CANCEL_FAILED_MESSAGE);
    expect(
      cancelErrorMessage({ kind: 'invalid', errors: { byField: {}, other: UNKNOWN_FIELD_ERROR } }),
    ).toBe(CANCEL_FAILED_MESSAGE);
    expect(cancelErrorMessage({ kind: 'duplicate', message: 'x' })).toBe(CANCEL_FAILED_MESSAGE);
  });
});
