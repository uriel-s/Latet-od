// Turns a validated booking form into the order to store (spec §3.1, §7): the api's own fields
// (token, region, status, source, dates) are added here, never taken from the request. Pure
// apart from the random token, so POST /api/orders and, later, Yoel's "הוספת הזמנה"
// (`source: 'collector'`, spec §3.5) build an order the same way and hand it to OrdersRepo.create.
import { randomBytes } from 'node:crypto';
import {
  ORDER_TOKEN_BYTES,
  regionForAddress,
  type NewOrder,
  type OrderForm,
  type OrderSource,
} from '@bottlerun/shared';

/**
 * A new secret for the customer's link `/o/<token>` (spec §3.3): {@link ORDER_TOKEN_BYTES} (32)
 * random bytes from node:crypto, i.e. 256 bits, as base64url without padding (43 characters, the
 * shape `orderTokenSchema` checks). Random on purpose and never derived from the order's id: the
 * id is guessable, and the token is the only thing that opens the customer's page.
 */
export function newOrderToken(): string {
  return randomBytes(ORDER_TOKEN_BYTES).toString('base64url');
}

/** What the caller decides about a new order; everything else comes from the form. */
export interface NewOrderOptions {
  /** When the order is created; both `createdAt` and `updatedAt` start at this moment. */
  now: Date;
  /** `form` for the public booking form, `collector` for Yoel's "הוספת הזמנה". */
  source: OrderSource;
}

/**
 * The order to store for a validated booking form: `waiting` (ממתינה לסבב), a fresh token, no
 * messages yet, contact by WhatsApp (the only method in the MVP), and the region derived from
 * the street.
 *
 * `region` is left out, not set to undefined, when the street gives none: a free-text street, or
 * a listed street the geocoding found no region for. Such an order is listed under "בלי אזור"
 * until Yoel assigns one (spec §3.5). The address is stored as the form gives it, without
 * `nearStreetCode`, which only Yoel sets. `form` is not changed.
 */
export function newOrderFromForm(form: OrderForm, options: NewOrderOptions): NewOrder {
  const order: NewOrder = {
    contact: { name: form.contact.name, phone: form.contact.phone, method: 'whatsapp' },
    // A shallow copy is a full one: every address field is a string or a number.
    address: { ...form.address },
    bottlesEstimated: form.bottlesEstimated,
    status: 'waiting',
    token: newOrderToken(),
    messages: [],
    source: options.source,
    // Two copies, so a later change to one date (or to the caller's `now`) moves nothing else.
    createdAt: new Date(options.now),
    updatedAt: new Date(options.now),
  };
  const region = regionForAddress(form.address);
  // Only when known: an explicit `region: undefined` would be a key the order should not have.
  if (region !== undefined) order.region = region;
  return order;
}
