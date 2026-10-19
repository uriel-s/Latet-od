// newOrderFromForm builds the stored order from the real booking-form output: every form here
// goes through orderFormSchema, as POST /api/orders will, so a change in the form's output that
// breaks the order shows up here.
import { describe, expect, it } from 'vitest';
import {
  STREETS,
  orderFormSchema,
  orderSchema,
  orderTokenSchema,
  type OrderForm,
  type OrderFormInput,
  type Street,
} from '@bottlerun/shared';
import { InMemoryOrdersRepo } from './inMemoryOrdersRepo.ts';
import { newOrderFromForm, newOrderToken } from './newOrderFromForm.ts';

const NOW = new Date('2026-10-19T08:30:00.000Z');

/** The first street of the real list that matches, or a failed test if there is none. */
function firstRealStreet(predicate: (street: Street) => boolean): Street {
  const street = STREETS.find(predicate);
  if (street === undefined) throw new Error('no street in data/streets.json matches');
  return street;
}

const RAMAT_STREET = firstRealStreet((street) => street.region === 'ramat');
const OLD_STREET = firstRealStreet((street) => street.region === 'old');
// A listed street the geocoding gave no region. The list has some today; once every street has
// a region, the case it covers no longer exists and its test is skipped.
const STREET_WITHOUT_REGION = STREETS.find((street) => street.region === undefined);

/** A free-text street ("הרחוב שלי לא ברשימה"): a name only, no code. */
const FREE_TEXT_ADDRESS = {
  streetName: 'הרחוב שלי',
  houseNumber: '12',
  bottlesSpot: 'privateHouse',
} as const;

/** The address of a street picked from the list, the way the web form sends it. */
function listedAddress(street: Street): OrderFormInput['address'] {
  return { streetCode: street.code, houseNumber: '12', bottlesSpot: 'buildingEntrance' };
}

/** A booking form as the web form sends it (bottles as typed text), validated by the real schema. */
function parseForm(
  address: OrderFormInput['address'] = FREE_TEXT_ADDRESS,
  phone = '050-1234567',
): OrderForm {
  return orderFormSchema.parse({
    contact: { name: 'משה כהן', phone },
    address,
    bottlesEstimated: '45',
  });
}

describe('newOrderToken', () => {
  it('is 43 base64url characters, the shape of a stored token', () => {
    const token = newOrderToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(orderTokenSchema.safeParse(token).success).toBe(true);
  });

  it('is different on every call', () => {
    expect(newOrderToken()).not.toBe(newOrderToken());
  });
});

describe('newOrderFromForm', () => {
  it('builds a waiting order with only the fields a new order has', () => {
    const form = parseForm({
      streetCode: OLD_STREET.code,
      houseNumber: '12א',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
      note: 'שקיות ליד הדלת',
    });

    const order = newOrderFromForm(form, { now: NOW, source: 'form' });

    // Strict: no roundId, lastMiss, bottlesCollected, collectedAt or cancelledAt key at all.
    expect(order).toStrictEqual({
      contact: { name: 'משה כהן', phone: '+972501234567', method: 'whatsapp' },
      address: {
        streetCode: OLD_STREET.code,
        streetName: OLD_STREET.name,
        houseNumber: '12א',
        bottlesSpot: 'apartmentDoor',
        floorApt: 'קומה 3, דירה 12',
        note: 'שקיות ליד הדלת',
      },
      bottlesEstimated: 45,
      status: 'waiting',
      region: 'old',
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      messages: [],
      source: 'form',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it.each([RAMAT_STREET, OLD_STREET])(
    'takes the region of the listed street ($region)',
    (street) => {
      const order = newOrderFromForm(parseForm(listedAddress(street)), {
        now: NOW,
        source: 'form',
      });

      expect(order.region).toBe(street.region);
    },
  );

  it('leaves the region out for a free-text street', () => {
    const order = newOrderFromForm(parseForm(FREE_TEXT_ADDRESS), { now: NOW, source: 'form' });

    // Absent, not undefined: listed under "בלי אזור" until Yoel assigns one (spec §3.5).
    expect(order).not.toHaveProperty('region');
    expect(order.address).toStrictEqual({
      streetName: 'הרחוב שלי',
      houseNumber: '12',
      bottlesSpot: 'privateHouse',
    });
  });

  it.skipIf(STREET_WITHOUT_REGION === undefined)(
    'leaves the region out for a listed street that has none',
    () => {
      // Narrows the type only: skipIf above already skips the test when there is no such street.
      if (STREET_WITHOUT_REGION === undefined) return;
      const form = parseForm(listedAddress(STREET_WITHOUT_REGION));

      const order = newOrderFromForm(form, { now: NOW, source: 'form' });

      expect(order).not.toHaveProperty('region');
      expect(order.address.streetCode).toBe(STREET_WITHOUT_REGION.code);
    },
  );

  it.each(['form', 'collector'] as const)('records the source %s', (source) => {
    const order = newOrderFromForm(parseForm(), { now: NOW, source });

    expect(order.source).toBe(source);
    expect(order.status).toBe('waiting');
  });

  it.each(['+972 50-123-4567', '050-1234567'])('stores the phone typed as %s in E.164', (phone) => {
    const order = newOrderFromForm(parseForm(FREE_TEXT_ADDRESS, phone), {
      now: NOW,
      source: 'form',
    });

    expect(order.contact).toStrictEqual({
      name: 'משה כהן',
      phone: '+972501234567',
      method: 'whatsapp',
    });
  });

  it('starts createdAt and updatedAt at now, as separate Date objects', () => {
    const order = newOrderFromForm(parseForm(), { now: NOW, source: 'form' });

    expect(order.createdAt).toEqual(NOW);
    expect(order.updatedAt).toEqual(NOW);
    expect(order.createdAt).not.toBe(order.updatedAt);
    expect(order.createdAt).not.toBe(NOW);
    expect(order.updatedAt).not.toBe(NOW);
  });

  it('gives every order its own token', () => {
    const form = parseForm();

    const first = newOrderFromForm(form, { now: NOW, source: 'form' });
    const second = newOrderFromForm(form, { now: NOW, source: 'form' });

    expect(first.token).not.toBe(second.token);
  });

  it('is a valid stored order once it has an id', () => {
    for (const address of [FREE_TEXT_ADDRESS, listedAddress(RAMAT_STREET)]) {
      const stored = {
        ...newOrderFromForm(parseForm(address), { now: NOW, source: 'form' }),
        id: '1',
      };

      // toStrictEqual also proves orderSchema stripped nothing: every key is a stored field.
      expect(orderSchema.parse(stored)).toStrictEqual(stored);
    }
  });

  it('is stored by the orders repo and found again by its token', async () => {
    const repo = new InMemoryOrdersRepo();
    const order = newOrderFromForm(parseForm(listedAddress(RAMAT_STREET)), {
      now: NOW,
      source: 'form',
    });

    const created = await repo.create(order);

    expect(created).toStrictEqual({ ...order, id: created.id });
    expect(await repo.findByToken(order.token)).toStrictEqual(created);
  });

  it('does not change the form, and shares no object with it', () => {
    const form = parseForm(listedAddress(OLD_STREET));
    const before = structuredClone(form);

    const order = newOrderFromForm(form, { now: NOW, source: 'form' });
    order.contact.name = 'שם אחר';
    order.address.houseNumber = '99';

    expect(form).toStrictEqual(before);
    expect(order.contact).not.toBe(form.contact);
    expect(order.address).not.toBe(form.address);
  });
});
