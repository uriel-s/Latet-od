import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ORDER_FORM_ERRORS,
  orderFormSchema,
  orderSchema,
  type Order,
  type OrderForm,
  type OrderFormInput,
} from './order.ts';
import {
  CREATE_ORDER_MESSAGES,
  ORDER_HONEYPOT_FIELD,
  createOrderResponseSchema,
  formFieldErrors,
  toOrderSummary,
  type CreateOrderRequest,
  type CreateOrderResponse,
} from './orderApi.ts';
import { PHONE_ERROR } from './phone.ts';
import { STREETS, type Street } from './streets.ts';

/** 43 base64url characters, the shape of a real token. */
const TOKEN = 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';
const CREATED_AT = new Date('2026-10-19T08:30:00.000Z');

function streetAt(index: number): Street {
  const street = STREETS[index];
  if (street === undefined) throw new Error(`data/streets.json has no street #${index}`);
  return street;
}

const STREET = streetAt(0);
const NEAR_STREET = streetAt(1);

/**
 * A stored order with every field set, internal ones included. The street has a code and also a
 * near street (a listed street whose point is wrong, ADR-0005), so both codes are present.
 */
function makeFullOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: '6710f3a2c4b5d6e7f8a9b0c1',
    contact: { name: 'משה כהן', phone: '+972501234567', method: 'whatsapp' },
    address: {
      streetCode: STREET.code,
      streetName: STREET.name,
      nearStreetCode: NEAR_STREET.code,
      houseNumber: '12א',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
      note: 'קוד לבניין 1234',
    },
    bottlesEstimated: 45,
    bottlesCollected: 50,
    status: 'collected',
    region: 'old',
    token: TOKEN,
    roundId: 'round-1',
    lastMiss: { date: '2026-10-12', reason: 'notFound', roundId: 'round-0' },
    messages: [
      {
        kind: 'confirmRequest',
        at: CREATED_AT,
        mode: 'manual',
        url: 'https://wa.me/972501234567?text=x',
      },
    ],
    source: 'form',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    collectedAt: CREATED_AT,
    ...overrides,
  };
}

/** A valid booking form, as the web form sends it. */
function makeFormInput(overrides: Partial<OrderFormInput> = {}): OrderFormInput {
  return {
    contact: { name: 'משה כהן', phone: '050-1234567' },
    address: { streetName: 'רחוב חדש', houseNumber: '12', bottlesSpot: 'privateHouse' },
    bottlesEstimated: 45,
    ...overrides,
  };
}

/** The stored order the api builds from a validated form (status, token and dates its own). */
function storeForm(form: OrderForm): Order {
  return orderSchema.parse({
    ...form,
    id: '6710f3a2c4b5d6e7f8a9b0c1',
    contact: { ...form.contact, method: 'whatsapp' },
    status: 'waiting',
    region: 'ramat',
    token: TOKEN,
    messages: [],
    source: 'form',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

/** Validates a form that must fail and returns its field errors. */
function fieldErrorsOf(input: unknown): Record<string, string> {
  const result = orderFormSchema.safeParse(input);
  if (result.success) throw new Error('expected the form to be rejected');
  return formFieldErrors(result.error);
}

describe('ORDER_HONEYPOT_FIELD', () => {
  it('is a key the request type accepts next to the form fields', () => {
    const request: CreateOrderRequest = { ...makeFormInput(), [ORDER_HONEYPOT_FIELD]: '' };
    expect(request).toHaveProperty('website', '');
  });
});

describe('toOrderSummary', () => {
  it('keeps only name, phone, address and bottles of a stored order', () => {
    expect(toOrderSummary(makeFullOrder())).toStrictEqual({
      contact: { name: 'משה כהן', phone: '+972501234567' },
      address: {
        streetCode: STREET.code,
        streetName: STREET.name,
        houseNumber: '12א',
        bottlesSpot: 'apartmentDoor',
        floorApt: 'קומה 3, דירה 12',
        note: 'קוד לבניין 1234',
      },
      bottlesEstimated: 45,
    });
  });

  it('leaves out the optional address fields an order does not have', () => {
    const summary = toOrderSummary(
      makeFullOrder({
        address: { streetName: 'רחוב חדש', houseNumber: '5', bottlesSpot: 'privateHouse' },
      }),
    );
    expect(summary.address).toStrictEqual({
      streetName: 'רחוב חדש',
      houseNumber: '5',
      bottlesSpot: 'privateHouse',
    });
  });

  it('gives a validated form the same summary as the order stored from it', () => {
    const inputs: OrderFormInput[] = [
      makeFormInput(),
      makeFormInput({
        contact: { name: ' משה כהן ', phone: '+972 50-123-4567' },
        address: {
          streetCode: STREET.code,
          houseNumber: '12א',
          bottlesSpot: 'apartmentDoor',
          floorApt: 'קומה 3, דירה 12',
          note: 'ליד השער',
        },
        bottlesEstimated: '45',
      }),
    ];
    for (const input of inputs) {
      const form = orderFormSchema.parse(input);
      expect(toOrderSummary(form)).toStrictEqual(toOrderSummary(storeForm(form)));
    }
  });
});

describe('createOrderResponseSchema', () => {
  const response: CreateOrderResponse = {
    token: TOKEN,
    order: toOrderSummary(makeFullOrder()),
  };

  it('accepts a valid response, also after the JSON round trip the api sends', () => {
    expect(createOrderResponseSchema.parse(response)).toStrictEqual(response);
    expect(createOrderResponseSchema.parse(JSON.parse(JSON.stringify(response)))).toStrictEqual(
      response,
    );
  });

  it('rejects a malformed token', () => {
    for (const token of ['', TOKEN.slice(1), `${TOKEN.slice(1)}=`]) {
      expect(createOrderResponseSchema.safeParse({ ...response, token }).success, token).toBe(
        false,
      );
    }
  });

  it('strips any internal field from the order, also inside contact and address', () => {
    const parsed = createOrderResponseSchema.parse({ token: TOKEN, order: makeFullOrder() });
    expect(parsed.order).toStrictEqual(response.order);
  });
});

describe('formFieldErrors', () => {
  it('maps too few bottles to its field', () => {
    expect(fieldErrorsOf(makeFormInput({ bottlesEstimated: 29 }))).toEqual({
      bottlesEstimated: ORDER_FORM_ERRORS.bottlesTooFew,
    });
  });

  it('maps a landline to the phone field', () => {
    const input = makeFormInput({ contact: { name: 'משה כהן', phone: '02-6543210' } });
    expect(fieldErrorsOf(input)).toEqual({ 'contact.phone': PHONE_ERROR });
  });

  it('maps a missing floor and apartment at the apartment door to its dotted path', () => {
    const input = makeFormInput({
      address: { streetName: 'רחוב חדש', houseNumber: '12', bottlesSpot: 'apartmentDoor' },
    });
    expect(fieldErrorsOf(input)).toEqual({
      'address.floorApt': ORDER_FORM_ERRORS.floorAptRequired,
    });
  });

  it('gives one key per failing field when several fail at once', () => {
    const errors = fieldErrorsOf({
      contact: { name: '', phone: '123' },
      address: { houseNumber: '', bottlesSpot: 'apartmentDoor' },
      bottlesEstimated: '',
    });
    expect(errors).toEqual({
      'contact.name': ORDER_FORM_ERRORS.nameRequired,
      'contact.phone': PHONE_ERROR,
      'address.streetName': ORDER_FORM_ERRORS.streetRequired,
      'address.houseNumber': ORDER_FORM_ERRORS.houseNumberRequired,
      'address.floorApt': ORDER_FORM_ERRORS.floorAptRequired,
      bottlesEstimated: ORDER_FORM_ERRORS.bottlesRequired,
    });
  });

  it('keeps only the first message of a field with several', () => {
    // Too long and not starting with a digit: two issues on the same field.
    const input = makeFormInput({
      address: { streetName: 'רחוב חדש', houseNumber: 'א'.repeat(11), bottlesSpot: 'privateHouse' },
    });
    const result = orderFormSchema.safeParse(input);
    expect(result.success).toBe(false);
    const houseNumberIssues = result.error?.issues.filter(
      (issue) => issue.path.join('.') === 'address.houseNumber',
    );
    expect(houseNumberIssues?.map((issue) => issue.message)).toEqual([
      ORDER_FORM_ERRORS.houseNumberTooLong,
      ORDER_FORM_ERRORS.houseNumberInvalid,
    ]);
    expect(fieldErrorsOf(input)).toEqual({
      'address.houseNumber': ORDER_FORM_ERRORS.houseNumberTooLong,
    });
  });

  it('keeps only the first message of a path in a hand-built error', () => {
    const error = new z.ZodError([
      { code: 'custom', path: ['contact', 'name'], message: 'first' },
      { code: 'custom', path: ['contact', 'name'], message: 'second' },
    ]);
    expect(formFieldErrors(error)).toEqual({ 'contact.name': 'first' });
  });

  it('gives no field errors for a body that is not an object', () => {
    for (const body of [[], null, 'הרצל 12', 42]) {
      expect(fieldErrorsOf(body), JSON.stringify(body)).toEqual({});
    }
  });

  it('never contains the value that was sent', () => {
    const badPhone = '02-6543210';
    const badHouseNumber = 'זזזזזזזזזזזזזזזז';
    const errors = fieldErrorsOf(
      makeFormInput({
        contact: { name: 'משה כהן', phone: badPhone },
        address: {
          streetName: 'רחוב חדש',
          houseNumber: badHouseNumber,
          bottlesSpot: 'privateHouse',
        },
      }),
    );
    const text = JSON.stringify(errors);
    expect(text).not.toContain(badPhone);
    expect(text).not.toContain(badHouseNumber);
  });
});

describe('CREATE_ORDER_MESSAGES', () => {
  it("uses the spec's exact text for a phone with an open order", () => {
    expect(CREATE_ORDER_MESSAGES.duplicateOpenOrder).toBe('כבר יש הזמנה פתוחה למספר הזה.');
  });
});
