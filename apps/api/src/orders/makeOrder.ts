// Test data for orders: a valid NewOrder in one call, so a test spells out only the fields it is
// about. Used by the OrdersRepo contract and, later, by the order service and route tests.
import type { NewOrder } from '@bottlerun/shared';

/** The moment every made order is created and last updated, unless a test overrides it. */
export const MADE_ORDER_CREATED_AT = new Date('2026-10-19T08:30:00.000Z');

// Counts made orders, so each one gets its own phone and token. Test-only module state: a test
// file that needs two orders of one customer copies `contact` from the first.
let madeOrders = 0;

/**
 * A valid new order (it passes `orderSchema` once a repo gives it an id): `waiting`, from the
 * form, WhatsApp contact, 40 bottles, a free-text street with no region yet, no messages, and
 * fixed `createdAt` / `updatedAt` ({@link MADE_ORDER_CREATED_AT}).
 *
 * Every call has a different phone (`+9725` + 8 digits) and a different token (43 base64url
 * characters), both from a counter: deterministic, and several orders never collide on the
 * one-open-order-per-phone rule or the unique token.
 *
 * `overrides` is merged shallowly: `contact` or `address` given here replaces the whole object,
 * so spread the default in to change one field (`{ contact: { ...other.contact } }`).
 */
export function makeNewOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  madeOrders += 1;
  const serial = String(madeOrders).padStart(8, '0');
  return {
    contact: { name: 'משה כהן', phone: `+9725${serial}`, method: 'whatsapp' },
    address: { streetName: 'הרחוב שלי', houseNumber: '12', bottlesSpot: 'privateHouse' },
    bottlesEstimated: 40,
    status: 'waiting',
    // 'test-token-' (11 characters) + 32 digits = the 43 characters of a real token.
    token: `test-token-${String(madeOrders).padStart(32, '0')}`,
    messages: [],
    source: 'form',
    createdAt: new Date(MADE_ORDER_CREATED_AT),
    updatedAt: new Date(MADE_ORDER_CREATED_AT),
    ...overrides,
  };
}
