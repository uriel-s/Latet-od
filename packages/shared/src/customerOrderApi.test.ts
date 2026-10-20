import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_ORDER_MESSAGES,
  customerOrderResponseSchema,
  customerUpdateOrderRequestSchema,
  isLocationChange,
  toCustomerOrder,
  type CustomerUpdateOrderRequest,
} from './customerOrderApi.ts';
import { ORDER_FORM_ERRORS, type Address, type Order } from './order.ts';
import { formFieldErrors } from './orderApi.ts';
import type { Round } from './round.ts';
import { STREETS, type Street } from './streets.ts';

const ERR = ORDER_FORM_ERRORS;
/** 43 base64url characters, the shape of a real token. */
const TOKEN = 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';
const ORDER_ID = '6710f3a2c4b5d6e7f8a9b0c1';
const ROUND_ID = '6720a1b2c3d4e5f6a7b8c9d0';
const CREATED_AT = new Date('2026-11-04T17:00:00.000Z');

/** The first street of the real list that matches, or a failed test if there is none. */
function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}

const RAMAT_STREET = firstRealStreet((street) => street.region === 'ramat');
const OLD_STREET = firstRealStreet((street) => street.region === 'old');

/** A stored address on a listed street, with every optional field set. */
const STORED_ADDRESS: Address = {
  streetCode: RAMAT_STREET.code,
  streetName: RAMAT_STREET.name,
  houseNumber: '12א',
  bottlesSpot: 'apartmentDoor',
  floorApt: 'קומה 3, דירה 12',
  note: 'קוד לבניין 1234',
};

/** A stored order, pending in round {@link ROUND_ID}, with every internal field set. */
function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    contact: { name: 'משה כהן', phone: '+972501234567', method: 'whatsapp' },
    address: { ...STORED_ADDRESS, nearStreetCode: OLD_STREET.code },
    bottlesEstimated: 45,
    status: 'pending',
    region: 'ramat',
    token: TOKEN,
    roundId: ROUND_ID,
    lastMiss: { date: '2026-10-29', reason: 'notConfirmed', roundId: 'round-0' },
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
    ...overrides,
  };
}

/** A stored open round in its confirmation step, with the order of {@link makeOrder}. */
function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: ROUND_ID,
    date: '2026-11-05',
    region: 'ramat',
    status: 'open',
    phase: 'confirming',
    personalText: 'השבוע נגיע מוקדם.',
    pickupBy: '08:00',
    orderIds: [ORDER_ID, 'another-customer'],
    stops: [],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Validates a PATCH body that must fail and returns its issues as `path: message`. */
function updateIssuesOf(body: unknown): string[] {
  const result = customerUpdateOrderRequestSchema.safeParse(body);
  if (result.success) throw new Error('expected the PATCH body to be rejected');
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('toCustomerOrder', () => {
  it('keeps only the fields the customer page shows', () => {
    expect(toCustomerOrder(makeOrder(), makeRound())).toStrictEqual({
      contact: { name: 'משה כהן', phone: '+972501234567' },
      address: STORED_ADDRESS,
      bottlesEstimated: 45,
      status: 'pending',
      round: { date: '2026-11-05', pickupBy: '08:00' },
    });
  });

  it('never carries the token, the ids or any other internal field', () => {
    const order = makeOrder({ bottlesCollected: 50, cancelledAt: CREATED_AT });
    const customerOrder = toCustomerOrder(order, makeRound());
    expect(Object.keys(customerOrder).sort()).toEqual(
      ['address', 'bottlesEstimated', 'contact', 'round', 'status'].sort(),
    );
    expect(Object.keys(customerOrder.contact).sort()).toEqual(['name', 'phone']);
    expect(customerOrder.address).not.toHaveProperty('nearStreetCode');
    expect(Object.keys(customerOrder.round ?? {}).sort()).toEqual(['date', 'pickupBy']);
    // Nothing of the order's or the round's internals, and nothing of the other customer.
    const json = JSON.stringify(customerOrder);
    for (const secret of [TOKEN, ORDER_ID, ROUND_ID, 'another-customer', 'round-0', 'wa.me']) {
      expect(json, secret).not.toContain(secret);
    }
  });

  it('gives a pending and a confirmed order in the round its date and pickup time', () => {
    for (const status of ['pending', 'confirmed'] as const) {
      expect(toCustomerOrder(makeOrder({ status }), makeRound()).round, status).toStrictEqual({
        date: '2026-11-05',
        pickupBy: '08:00',
      });
    }
  });

  it('leaves pickupBy out when the round has none', () => {
    const round = makeRound();
    delete round.pickupBy;
    expect(toCustomerOrder(makeOrder(), round).round).toStrictEqual({ date: '2026-11-05' });
  });

  it('shows no round for a waiting, collected or cancelled order', () => {
    // Even with a roundId left behind and that round given: the status decides.
    for (const status of ['waiting', 'collected', 'cancelled'] as const) {
      expect(toCustomerOrder(makeOrder({ status }), makeRound()), status).not.toHaveProperty(
        'round',
      );
    }
  });

  it('shows no round when the round given is another one, or none is given', () => {
    const otherRound = makeRound({ id: 'another-round' });
    expect(toCustomerOrder(makeOrder(), otherRound)).not.toHaveProperty('round');
    expect(toCustomerOrder(makeOrder(), null)).not.toHaveProperty('round');
    expect(toCustomerOrder(makeOrder(), undefined)).not.toHaveProperty('round');
    const notInARound = makeOrder({ status: 'waiting' });
    delete notInARound.roundId;
    expect(toCustomerOrder(notInARound, makeRound())).not.toHaveProperty('round');
  });
});

describe('customerOrderResponseSchema', () => {
  it('reads the JSON of a response back into the same response, with and without a round', () => {
    for (const round of [makeRound(), undefined]) {
      const response = { order: toCustomerOrder(makeOrder(), round) };
      expect(customerOrderResponseSchema.parse(JSON.parse(JSON.stringify(response)))).toStrictEqual(
        response,
      );
    }
  });

  it('rejects a round date that is not YYYY-MM-DD', () => {
    const order = toCustomerOrder(makeOrder(), makeRound());
    const body = { order: { ...order, round: { date: '05/11' } } };
    expect(customerOrderResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('customerUpdateOrderRequestSchema', () => {
  it('accepts the address alone, or the bottles alone', () => {
    const bodies: CustomerUpdateOrderRequest[] = [
      { address: { streetCode: OLD_STREET.code, houseNumber: '7', bottlesSpot: 'privateHouse' } },
      { bottlesEstimated: 60 },
      { bottlesEstimated: '60' },
    ];
    for (const body of bodies) {
      expect(customerUpdateOrderRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        true,
      );
    }
  });

  it('applies the form rules: trimmed text, official street name, bottles as a number', () => {
    expect(
      customerUpdateOrderRequestSchema.parse({
        address: {
          streetCode: OLD_STREET.code,
          streetName: 'שם שהלקוח שלח',
          houseNumber: ' 7 ',
          bottlesSpot: 'buildingEntrance',
          floorApt: '  ',
          note: ' להשאיר ליד העציץ ',
        },
        bottlesEstimated: ' 60 ',
      }),
    ).toStrictEqual({
      address: {
        streetCode: OLD_STREET.code,
        streetName: OLD_STREET.name,
        houseNumber: '7',
        bottlesSpot: 'buildingEntrance',
        note: 'להשאיר ליד העציץ',
      },
      bottlesEstimated: 60,
    });
  });

  it('rejects fewer than 30 bottles with the form message', () => {
    expect(updateIssuesOf({ bottlesEstimated: 29 })).toEqual([
      `bottlesEstimated: ${ERR.bottlesTooFew}`,
    ]);
  });

  it('asks for floor and apartment when the bottles wait at the apartment door', () => {
    const address = { streetCode: OLD_STREET.code, houseNumber: '7', bottlesSpot: 'apartmentDoor' };
    expect(updateIssuesOf({ address })).toEqual([`address.floorApt: ${ERR.floorAptRequired}`]);
  });

  it('refuses a body with nothing to change', () => {
    expect(customerUpdateOrderRequestSchema.safeParse({}).success).toBe(false);
    expect(customerUpdateOrderRequestSchema.safeParse({ address: undefined }).success).toBe(false);
  });

  // spec §3.3: "לא את הטלפון". Not even together with a change that is allowed.
  it('refuses a phone change: contact is not a key the customer may send', () => {
    const result = customerUpdateOrderRequestSchema.safeParse({
      contact: { name: 'משה כהן', phone: '052-7654321' },
      bottlesEstimated: 60,
    });
    if (result.success) throw new Error('expected the phone change to be refused');
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['contact'] }),
    );
    // A refusal of the body as a whole: no field to show it on, so no field message either.
    expect(formFieldErrors(result.error)).toEqual({});
  });

  it('refuses a status, or any other key Yoel or the api sets', () => {
    for (const unknownKey of ['status', 'region', 'nearStreetCode', 'token', 'roundId']) {
      const result = customerUpdateOrderRequestSchema.safeParse({
        bottlesEstimated: 60,
        [unknownKey]: 'x',
      });
      expect(result.success, unknownKey).toBe(false);
      expect(result.error?.issues, unknownKey).toContainEqual(
        expect.objectContaining({ code: 'unrecognized_keys', keys: [unknownKey] }),
      );
    }
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, [], 'address', 42]) {
      expect(customerUpdateOrderRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });
});

describe('isLocationChange', () => {
  it('is false for the same place', () => {
    expect(isLocationChange(STORED_ADDRESS, { ...STORED_ADDRESS })).toBe(false);
  });

  it('is true when the street code changes', () => {
    const after = { ...STORED_ADDRESS, streetCode: OLD_STREET.code, streetName: OLD_STREET.name };
    expect(isLocationChange(STORED_ADDRESS, after)).toBe(true);
  });

  it('is true when a listed street becomes a free-text one', () => {
    const freeText: Address = { ...STORED_ADDRESS };
    delete freeText.streetCode;
    expect(isLocationChange(STORED_ADDRESS, freeText)).toBe(true);
  });

  it('is true when the free-text street name changes', () => {
    const before: Address = {
      streetName: 'רחוב חדש',
      houseNumber: '5',
      bottlesSpot: 'privateHouse',
    };
    expect(isLocationChange(before, { ...before, streetName: 'רחוב אחר' })).toBe(true);
  });

  it('is true when the house number changes', () => {
    expect(isLocationChange(STORED_ADDRESS, { ...STORED_ADDRESS, houseNumber: '14' })).toBe(true);
  });

  // spec §3.3: only a change of WHERE takes the order out of its round.
  it('is false when only the bottles spot, the floor and apartment, or the note change', () => {
    const changes: Partial<Address>[] = [
      { bottlesSpot: 'buildingEntrance' },
      { floorApt: 'קומה 4, דירה 15' },
      { note: 'להתקשר כשמגיעים' },
    ];
    for (const change of changes) {
      expect(isLocationChange(STORED_ADDRESS, { ...STORED_ADDRESS, ...change })).toBe(false);
    }
    const withoutOptional: Address = { ...STORED_ADDRESS };
    delete withoutOptional.floorApt;
    delete withoutOptional.note;
    expect(isLocationChange(STORED_ADDRESS, withoutOptional)).toBe(false);
  });

  it('is false for a PATCH that sends the same street under another name', () => {
    const update = customerUpdateOrderRequestSchema.parse({
      address: {
        streetCode: RAMAT_STREET.code,
        streetName: 'שם אחר',
        houseNumber: ' 12א ',
        bottlesSpot: 'privateHouse',
      },
    });
    if (update.address === undefined) throw new Error('expected an address');
    expect(isLocationChange(STORED_ADDRESS, update.address)).toBe(false);
  });
});

describe('CUSTOMER_ORDER_MESSAGES', () => {
  it('has the plain-Hebrew messages the customer sees', () => {
    // Word for word from spec §3.3.
    expect(CUSTOMER_ORDER_MESSAGES.confirmationsClosed).toBe(
      'האישור נסגר. נחזור אליך עם מועד חדש.',
    );
    expect(CUSTOMER_ORDER_MESSAGES.orderClosed).toBe('ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.');
    expect(CUSTOMER_ORDER_MESSAGES.orderNotFound).toBe(
      'לא מצאנו את ההזמנה. ייתכן שהקישור לא הועתק עד הסוף.',
    );
  });
});
