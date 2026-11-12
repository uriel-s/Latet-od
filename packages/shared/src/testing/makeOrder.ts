// Test data for orders, shared by every workspace through `@bottlerun/shared/testing`: one call
// gives a valid order, so a test spells out only the fields it is about. Four shapes, one per
// place an order appears: a NewOrder for a repo to store (api), the stored Order (shared logic),
// and the two views the screens get, CollectorOrder (Yoel's app) and CustomerOrder (`/o/<token>`).
//
// Every `overrides` is merged shallowly: `contact` or `address` given there replaces the whole
// object, so spread the default in to change one field (`{ address: { ...order.address, note } }`).
// An override of `undefined` keeps the key with the value `undefined` (as a plain spread does).
import type { CollectorOrder } from '../collectorOrdersApi.ts';
import type { CustomerOrder } from '../customerOrderApi.ts';
import type { NewOrder, Order } from '../order.ts';

/** The moment every made order is created and last updated, unless a test overrides it. */
export const MADE_ORDER_CREATED_AT = new Date('2026-10-19T08:30:00.000Z');

/** The id of {@link makeOrder}: 24 hex characters, the shape of a Mongo ObjectId. */
export const MADE_ORDER_ID = '6710f3a2c4b5d6e7f8a9b0c1';

/** The token of {@link makeOrder}: 43 base64url characters, the shape of a real token. */
export const MADE_ORDER_TOKEN = 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';

// Counts made new orders, so each one gets its own phone and token. Test-only module state: a test
// file that needs two orders of one customer copies `contact` from the first.
let madeNewOrders = 0;

/**
 * A valid new order (it passes `orderSchema` once a repo gives it an id): `waiting`, from the
 * form, in Hebrew, WhatsApp contact, 40 bottles, a free-text street with no region yet, no messages, and
 * fixed `createdAt` / `updatedAt` ({@link MADE_ORDER_CREATED_AT}).
 *
 * Every call has a different phone (`+9725` + 8 digits) and a different token (43 base64url
 * characters), both from a counter: deterministic, and several orders stored in one repo never
 * collide on the one-open-order-per-phone rule or the unique token.
 */
export function makeNewOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  madeNewOrders += 1;
  const serial = String(madeNewOrders).padStart(8, '0');
  return {
    contact: { name: 'משה כהן', phone: `+9725${serial}`, method: 'whatsapp' },
    address: { streetName: 'הרחוב שלי', houseNumber: '12', bottlesSpot: 'privateHouse' },
    bottlesEstimated: 40,
    status: 'waiting',
    // 'test-token-' (11 characters) + 32 digits = the 43 characters of a real token.
    token: `test-token-${String(madeNewOrders).padStart(32, '0')}`,
    messages: [],
    source: 'form',
    lang: 'he',
    createdAt: new Date(MADE_ORDER_CREATED_AT),
    updatedAt: new Date(MADE_ORDER_CREATED_AT),
    ...overrides,
  };
}

/**
 * A valid stored order, as a repo returns it from Mongo (Dates, not strings): `waiting`, in no
 * round, on a listed street of בית שמש הוותיקה (הרצל 12א, code 101, region `old`) with every
 * optional address field set, 45 bottles, no messages, created {@link MADE_ORDER_CREATED_AT}.
 *
 * Unlike {@link makeNewOrder}, every value is fixed (id {@link MADE_ORDER_ID}, phone
 * `+972501234567`, token {@link MADE_ORDER_TOKEN}): logic tests compare whole objects, and a
 * stored order is not put in a repo, so there is no uniqueness rule to keep.
 */
export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: MADE_ORDER_ID,
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
    token: MADE_ORDER_TOKEN,
    messages: [],
    source: 'form',
    lang: 'he',
    createdAt: new Date(MADE_ORDER_CREATED_AT),
    updatedAt: new Date(MADE_ORDER_CREATED_AT),
    ...overrides,
  };
}

/**
 * An order as Yoel's screens get it (`toCollectorOrder`): `waiting`, id `o1`, דנה כהן, on a listed
 * street of רמת בית שמש with a map point (שד נהר הדן 12, code 201), an apartment door with no
 * floor or note, 40 bottles, from the form. No `deletable`, which reads as "not offered".
 */
export function makeCollectorOrder(overrides: Partial<CollectorOrder> = {}): CollectorOrder {
  return {
    id: 'o1',
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 201,
      streetName: 'שד נהר הדן',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
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

/**
 * An order as its customer's page gets it (GET /api/o/:token, `toCustomerOrder`): `waiting`, so in
 * no round, in Hebrew, דנה כהן on a listed street (דרך רבין יצחק 12, code 247) with every optional
 * address field set, 40 bottles. An order in a round also has `round`: pass it in `overrides`.
 */
export function makeCustomerOrder(overrides: Partial<CustomerOrder> = {}): CustomerOrder {
  return {
    contact: { name: 'דנה כהן', phone: '+972501234567' },
    address: {
      streetCode: 247,
      streetName: 'דרך רבין יצחק',
      houseNumber: '12',
      bottlesSpot: 'apartmentDoor',
      floorApt: 'קומה 3, דירה 12',
      note: 'ליד העגלה הכחולה',
    },
    bottlesEstimated: 40,
    status: 'waiting',
    lang: 'he',
    ...overrides,
  };
}
