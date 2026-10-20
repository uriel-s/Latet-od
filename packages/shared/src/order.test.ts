import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BOTTLES_SPOT_LABELS,
  MISS_REASON_LABELS,
  ORDER_FORM_ERRORS,
  ORDER_TOKEN_BYTES,
  bottlesSpotSchema,
  missReasonSchema,
  orderFormSchema,
  orderSchema,
  timestampSchema,
  type MessageLogEntry,
  type Order,
  type OrderFormInput,
} from './order.ts';
import { PHONE_ERROR } from './phone.ts';
import { STREETS, type Street } from './streets.ts';

/** 43 base64url characters, the shape of a real token. */
const TOKEN = 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';
const CREATED_AT = new Date('2026-10-19T08:30:00.000Z');

/** A valid stored order (as the repo returns it from Mongo: Dates, not strings). */
function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: '6710f3a2c4b5d6e7f8a9b0c1',
    contact: { name: 'משה כהן', phone: '+972501234567', method: 'whatsapp' },
    address: {
      streetCode: 101,
      streetName: 'הרצל',
      houseNumber: '12א',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
      note: 'קוד לבניין 1234',
    },
    bottlesEstimated: 45,
    status: 'waiting',
    region: 'old',
    token: TOKEN,
    messages: [],
    source: 'form',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
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

/** Booking form with only the address fields changed. */
function makeFormWithAddress(address: Record<string, unknown>): OrderFormInput {
  return makeFormInput({ address: address as OrderFormInput['address'] });
}

/** The messages of the issues on exactly `path`. */
function messagesAt(error: z.ZodError, path: readonly PropertyKey[]): string[] {
  return error.issues
    .filter((issue) => JSON.stringify(issue.path) === JSON.stringify(path))
    .map((issue) => issue.message);
}

/** Parses and fails the test with the issues if the form is rejected. */
function parseForm(input: unknown) {
  const result = orderFormSchema.safeParse(input);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2));
  return result.data;
}

/** Parses and fails the test if the form is accepted. */
function formError(input: unknown): z.ZodError {
  const result = orderFormSchema.safeParse(input);
  if (result.success) throw new Error('expected the form to be rejected');
  return result.error;
}

function realStreet(): Street {
  const street = STREETS[0];
  if (street === undefined) throw new Error('data/streets.json has no streets');
  return street;
}

const UNKNOWN_STREET_CODE = Math.max(...STREETS.map((street) => street.code)) + 1;

describe('orderSchema', () => {
  it('parses a stored order with Date objects', () => {
    const order = makeOrder();
    expect(orderSchema.parse(order)).toEqual(order);
  });

  it('parses the same order after a JSON round trip (ISO strings) back to equal Dates', () => {
    const order = makeOrder({
      collectedAt: new Date('2026-10-21T15:00:00.000Z'),
      messages: [
        {
          kind: 'confirmRequest',
          at: CREATED_AT,
          mode: 'manual',
          url: 'https://wa.me/972501234567?text=x',
          openedAt: CREATED_AT,
        },
      ],
    });
    const fromJson = orderSchema.parse(JSON.parse(JSON.stringify(order)));
    expect(fromJson).toEqual(order);
    expect(fromJson.createdAt).toBeInstanceOf(Date);
  });

  it("strips Mongo's _id and other unknown keys", () => {
    const parsed = orderSchema.parse({ ...makeOrder(), _id: 'abc', extra: 1 });
    expect(parsed).not.toHaveProperty('_id');
    expect(parsed).not.toHaveProperty('extra');
  });

  it('accepts a free-text street with a near street and no region', () => {
    const order = makeOrder({
      address: {
        streetName: 'רחוב חדש',
        nearStreetCode: 101,
        houseNumber: '5',
        bottlesSpot: 'privateHouse',
      },
      region: undefined,
    });
    expect(orderSchema.safeParse(order).success).toBe(true);
  });

  it('rejects a phone that is not E.164', () => {
    const order = makeOrder({ contact: { name: 'משה', phone: '050-1234567', method: 'whatsapp' } });
    expect(orderSchema.safeParse(order).success).toBe(false);
  });

  it('rejects a token of the wrong length or alphabet', () => {
    for (const token of [TOKEN.slice(1), `${TOKEN}A`, `${TOKEN.slice(1)}=`, `${TOKEN.slice(1)}+`]) {
      expect(orderSchema.safeParse(makeOrder({ token })).success, token).toBe(false);
    }
  });

  it('rejects fewer than 30 bottles', () => {
    expect(orderSchema.safeParse(makeOrder({ bottlesEstimated: 29 })).success).toBe(false);
    expect(orderSchema.safeParse(makeOrder({ bottlesEstimated: 30 })).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const order = { ...makeOrder(), status: 'archived' };
    expect(orderSchema.safeParse(order).success).toBe(false);
  });

  it('rejects a null date instead of reading it as 1970', () => {
    expect(orderSchema.safeParse({ ...makeOrder(), collectedAt: null }).success).toBe(false);
    expect(timestampSchema.safeParse(0).success).toBe(false);
    expect(timestampSchema.safeParse('not a date').success).toBe(false);
  });

  it('accepts a lastMiss with an ISO calendar date and rejects any other date form', () => {
    const lastMiss = { date: '2026-11-12', reason: 'notConfirmed', roundId: 'r1' } as const;
    expect(orderSchema.safeParse(makeOrder({ lastMiss })).success).toBe(true);
    for (const date of ['12/11', '2026-11-12T10:00:00Z', '2026-13-01']) {
      const order = makeOrder({ lastMiss: { ...lastMiss, date } });
      expect(orderSchema.safeParse(order).success, date).toBe(false);
    }
  });

  describe('messages log', () => {
    const entries: MessageLogEntry[] = [
      { kind: 'confirmRequest', at: CREATED_AT, mode: 'sent', providerId: 'wamid.123' },
      { kind: 'confirmRequest', at: CREATED_AT, mode: 'manual', url: 'https://wa.me/972501234567' },
      {
        kind: 'thankYou',
        at: CREATED_AT,
        mode: 'manual',
        url: 'https://wa.me/972501234567',
        openedAt: CREATED_AT,
      },
      { kind: 'thankYou', at: CREATED_AT, mode: 'failed', reason: 'timeout' },
    ];

    it('parses every mode', () => {
      const order = makeOrder({ messages: entries });
      expect(orderSchema.parse(order).messages).toEqual(entries);
    });

    it('rejects a manual entry without a url', () => {
      const messages = [{ kind: 'confirmRequest', at: CREATED_AT, mode: 'manual' }];
      expect(orderSchema.safeParse({ ...makeOrder(), messages }).success).toBe(false);
    });

    it('rejects a manual entry whose url is not https', () => {
      const messages = [
        { kind: 'confirmRequest', at: CREATED_AT, mode: 'manual', url: 'javascript:alert(1)' },
      ];
      expect(orderSchema.safeParse({ ...makeOrder(), messages }).success).toBe(false);
    });

    it('rejects an unknown mode or kind', () => {
      const unknownMode = [{ kind: 'thankYou', at: CREATED_AT, mode: 'queued' }];
      const unknownKind = [{ kind: 'received', at: CREATED_AT, mode: 'failed', reason: 'x' }];
      expect(orderSchema.safeParse({ ...makeOrder(), messages: unknownMode }).success).toBe(false);
      expect(orderSchema.safeParse({ ...makeOrder(), messages: unknownKind }).success).toBe(false);
    });
  });
});

describe('labels', () => {
  it('has a Hebrew label for every bottles spot and miss reason', () => {
    expect(Object.keys(BOTTLES_SPOT_LABELS)).toEqual(bottlesSpotSchema.options);
    expect(Object.keys(MISS_REASON_LABELS)).toEqual(missReasonSchema.options);
    expect(BOTTLES_SPOT_LABELS.apartmentDoor).toBe('ליד דלת הדירה');
  });

  it('documents a token length that matches its random bytes', () => {
    expect(Math.ceil((ORDER_TOKEN_BYTES * 4) / 3)).toBe(TOKEN.length);
  });
});

describe('orderFormSchema', () => {
  it('accepts a street from the list, outputs the phone in E.164 and the official street name', () => {
    const street = realStreet();
    const form = parseForm(
      makeFormWithAddress({
        streetCode: street.code,
        streetName: 'שם אחר שהלקוח שלח',
        houseNumber: '12',
        bottlesSpot: 'buildingEntrance',
      }),
    );
    expect(form.contact.phone).toBe('+972501234567');
    expect(form.address).toEqual({
      streetCode: street.code,
      streetName: street.name,
      houseNumber: '12',
      bottlesSpot: 'buildingEntrance',
    });
  });

  it('accepts a street code without a name', () => {
    const street = realStreet();
    const form = parseForm(
      makeFormWithAddress({
        streetCode: street.code,
        houseNumber: '7',
        bottlesSpot: 'privateHouse',
      }),
    );
    expect(form.address.streetName).toBe(street.name);
  });

  it('accepts a free-text street without a code', () => {
    const form = parseForm(makeFormInput());
    expect(form.address.streetCode).toBeUndefined();
    expect(form.address.streetName).toBe('רחוב חדש');
  });

  it('rejects a street code that is not in the list', () => {
    const error = formError(
      makeFormWithAddress({
        streetCode: UNKNOWN_STREET_CODE,
        houseNumber: '1',
        bottlesSpot: 'privateHouse',
      }),
    );
    expect(messagesAt(error, ['address', 'streetCode'])).toEqual(['הרחוב לא נמצא ברשימה']);
    // The street was given, so "choose a street" is not reported on top of it.
    expect(messagesAt(error, ['address', 'streetName'])).toEqual([]);
  });

  it('rejects an address with neither a street code nor a street name', () => {
    for (const streetName of [undefined, '', '   ']) {
      const error = formError(
        makeFormWithAddress({ streetName, houseNumber: '1', bottlesSpot: 'privateHouse' }),
      );
      expect(messagesAt(error, ['address', 'streetName']), String(streetName)).toEqual([
        'נא לבחור רחוב או לכתוב אותו',
      ]);
    }
  });

  it('rejects fewer than 30 bottles with a Hebrew message on the field', () => {
    const error = formError(makeFormInput({ bottlesEstimated: 29 }));
    expect(messagesAt(error, ['bottlesEstimated'])).toEqual(['צריך לפחות 30 בקבוקים']);
    expect(parseForm(makeFormInput({ bottlesEstimated: 30 })).bottlesEstimated).toBe(30);
  });

  it('rejects a typo far above any real order', () => {
    const error = formError(makeFormInput({ bottlesEstimated: 30000 }));
    expect(messagesAt(error, ['bottlesEstimated'])).toEqual([ORDER_FORM_ERRORS.bottlesTooMany]);
  });

  it('turns the number of bottles typed as a string into a number', () => {
    expect(parseForm(makeFormInput({ bottlesEstimated: '45' })).bottlesEstimated).toBe(45);
    expect(parseForm(makeFormInput({ bottlesEstimated: ' 45 ' })).bottlesEstimated).toBe(45);
  });

  it('rejects a blank, missing or non-numeric number of bottles with "write a number"', () => {
    for (const bottlesEstimated of ['', '  ', 'abc', '4,5', '1e3', 45.5, null, undefined]) {
      const error = formError(makeFormInput({ bottlesEstimated }));
      expect(messagesAt(error, ['bottlesEstimated']), String(bottlesEstimated)).toEqual([
        'נא לכתוב מספר בקבוקים',
      ]);
    }
  });

  it('requires floor and apartment when the bottles are at the apartment door', () => {
    const error = formError(
      makeFormWithAddress({
        streetName: 'רחוב חדש',
        houseNumber: '12',
        bottlesSpot: 'apartmentDoor',
      }),
    );
    expect(messagesAt(error, ['address', 'floorApt'])).toEqual(['נא לכתוב קומה ודירה']);

    const blank = formError(
      makeFormWithAddress({
        streetName: 'רחוב חדש',
        houseNumber: '12',
        bottlesSpot: 'apartmentDoor',
        floorApt: '  ',
      }),
    );
    expect(messagesAt(blank, ['address', 'floorApt'])).toEqual(['נא לכתוב קומה ודירה']);
  });

  it('accepts the apartment door with floor and apartment', () => {
    const form = parseForm(
      makeFormWithAddress({
        streetName: 'רחוב חדש',
        houseNumber: '12',
        bottlesSpot: 'apartmentDoor',
        floorApt: " כניסה ב', קומה 3, דירה 12 ",
      }),
    );
    expect(form.address.floorApt).toBe("כניסה ב', קומה 3, דירה 12");
  });

  it('does not require floor and apartment for a private house', () => {
    const form = parseForm(makeFormInput());
    expect(form.address.bottlesSpot).toBe('privateHouse');
    expect(form.address.floorApt).toBeUndefined();
  });

  it('reports every mistake at once, also the floor and apartment next to other address errors', () => {
    const error = formError({
      contact: { name: '', phone: '123' },
      address: { houseNumber: '', bottlesSpot: 'apartmentDoor' },
      bottlesEstimated: '',
    });
    expect(messagesAt(error, ['contact', 'name'])).toEqual(['נא לכתוב שם']);
    expect(messagesAt(error, ['contact', 'phone'])).toEqual([PHONE_ERROR]);
    expect(messagesAt(error, ['address', 'streetName'])).toEqual(['נא לבחור רחוב או לכתוב אותו']);
    expect(messagesAt(error, ['address', 'houseNumber'])).toEqual(['נא לכתוב מספר בית']);
    expect(messagesAt(error, ['address', 'floorApt'])).toEqual(['נא לכתוב קומה ודירה']);
    expect(messagesAt(error, ['bottlesEstimated'])).toEqual(['נא לכתוב מספר בקבוקים']);
  });

  it('leaves out empty-string note and floor and apartment', () => {
    const form = parseForm(
      makeFormWithAddress({
        streetName: 'רחוב חדש',
        houseNumber: '12',
        bottlesSpot: 'privateHouse',
        floorApt: '',
        note: '   ',
      }),
    );
    expect(form.address.note).toBeUndefined();
    expect(form.address.floorApt).toBeUndefined();
    // Absent, not undefined: the Mongo driver would store an undefined as null.
    expect(form.address).not.toHaveProperty('note');
    expect(form.address).not.toHaveProperty('floorApt');
  });

  it('trims the text fields', () => {
    const form = parseForm({
      contact: { name: '  משה כהן ', phone: '050-1234567' },
      address: {
        streetName: ' רחוב חדש ',
        houseNumber: ' 12 ',
        bottlesSpot: 'privateHouse',
        note: ' ליד השער ',
      },
      bottlesEstimated: 45,
    });
    expect(form.contact.name).toBe('משה כהן');
    expect(form.address).toEqual({
      streetName: 'רחוב חדש',
      houseNumber: '12',
      bottlesSpot: 'privateHouse',
      note: 'ליד השער',
    });
  });

  it('accepts a house number with a letter', () => {
    for (const houseNumber of ['12א', '12 ב', '3/1']) {
      const form = parseForm(
        makeFormWithAddress({ streetName: 'רחוב חדש', houseNumber, bottlesSpot: 'privateHouse' }),
      );
      expect(form.address.houseNumber).toBe(houseNumber);
    }
  });

  it('rejects a house number that does not start with a digit, or is missing', () => {
    const letters = formError(
      makeFormWithAddress({
        streetName: 'רחוב חדש',
        houseNumber: 'אבג',
        bottlesSpot: 'privateHouse',
      }),
    );
    expect(messagesAt(letters, ['address', 'houseNumber'])).toEqual([
      ORDER_FORM_ERRORS.houseNumberInvalid,
    ]);
    const missing = formError(
      makeFormWithAddress({ streetName: 'רחוב חדש', bottlesSpot: 'privateHouse' }),
    );
    expect(messagesAt(missing, ['address', 'houseNumber'])).toEqual(['נא לכתוב מספר בית']);
  });

  it('rejects a missing name with a Hebrew message', () => {
    const error = formError({ ...makeFormInput(), contact: { phone: '050-1234567' } });
    expect(messagesAt(error, ['contact', 'name'])).toEqual(['נא לכתוב שם']);
  });

  it('rejects a missing bottles spot with a Hebrew message', () => {
    const error = formError(makeFormWithAddress({ streetName: 'רחוב חדש', houseNumber: '12' }));
    expect(messagesAt(error, ['address', 'bottlesSpot'])).toEqual(['נא לבחור איפה הבקבוקים']);
  });

  it('rejects text longer than the field allows', () => {
    const error = formError(
      makeFormWithAddress({
        streetName: 'רחוב חדש',
        houseNumber: '12',
        bottlesSpot: 'privateHouse',
        note: 'א'.repeat(201),
      }),
    );
    expect(messagesAt(error, ['address', 'note'])).toEqual(['ההערה ארוכה מדי']);
  });

  it('accepts a phone in the international form', () => {
    const form = parseForm(makeFormInput({ contact: { name: 'משה', phone: '+972 50-123-4567' } }));
    expect(form.contact.phone).toBe('+972501234567');
  });

  it('strips unknown keys, so a client cannot set status, region or nearStreetCode', () => {
    const form = parseForm({
      ...makeFormInput(),
      status: 'collected',
      region: 'ramat',
      website: 'spam',
      address: {
        streetName: 'רחוב חדש',
        houseNumber: '12',
        bottlesSpot: 'privateHouse',
        nearStreetCode: 101,
      },
    });
    expect(form).not.toHaveProperty('status');
    expect(form).not.toHaveProperty('region');
    expect(form).not.toHaveProperty('website');
    expect(form.address).not.toHaveProperty('nearStreetCode');
  });

  it('rejects a body that is not an object without throwing', () => {
    expect(orderFormSchema.safeParse(null).success).toBe(false);
    expect(orderFormSchema.safeParse({ ...makeFormInput(), address: 'הרצל 12' }).success).toBe(
      false,
    );
    expect(orderFormSchema.safeParse({ ...makeFormInput(), address: undefined }).success).toBe(
      false,
    );
  });
});
