// A returning customer's details (spec §3.1, "לקוח חוזר"): the browser remembers them and fills
// the form in the next time. Two sources feed the same prefill: localStorage, written after a
// successful order, and the navigation state of "הזמנה חדשה עם אותם פרטים" on the customer page
// (section 9). Both are read through the shared schema, because both can hold anything: an old
// app version's shape, hand-edited storage, a stale history entry.
import {
  findStreet,
  formatIsraeliMobileLocal,
  orderSummarySchema,
  type OrderSummary,
} from '@bottlerun/shared';
import type { OrderFormValues } from './formValues.ts';

/**
 * The details a returning customer gets filled in: contact and address, in the stored form (the
 * phone in E.164, the official street name). Deliberately not the number of bottles: it differs
 * from one order to the next, and a remembered count would be sent unchecked by a customer who
 * did not look at it.
 */
export const orderPrefillSchema = orderSummarySchema.pick({ contact: true, address: true });

/** What {@link orderPrefillSchema} outputs. Spelled as a Pick so apps/web needs no zod import. */
export type OrderPrefill = Pick<OrderSummary, 'contact' | 'address'>;

/** The localStorage key of the saved details. */
export const SAVED_DETAILS_KEY = 'bottlerun.orderDetails';

/**
 * The details saved by {@link saveDetails}, or null when there are none to use: nothing saved,
 * storage blocked (some private modes throw on merely reading `window.localStorage`), corrupt
 * JSON, or a shape the schema no longer accepts. Never throws: a prefill is a convenience, and
 * the form works without it.
 */
export function loadSavedDetails(storage?: Pick<Storage, 'getItem'>): OrderPrefill | null {
  try {
    // Inside the try: accessing window.localStorage is what throws when storage is blocked.
    const saved = (storage ?? window.localStorage).getItem(SAVED_DETAILS_KEY);
    if (saved === null) return null;
    const json: unknown = JSON.parse(saved);
    const parsed = orderPrefillSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Remembers the details for the customer's next order: contact and address only. A whole
 * {@link OrderSummary} may be passed (the 201 answer's `order`): parsing with the schema strips
 * the number of bottles and anything else before storing. Silently does nothing when the details
 * do not parse or storage is blocked or full: the order is already placed, and not remembering it
 * costs the customer only some typing next time.
 */
export function saveDetails(details: OrderPrefill, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const parsed = orderPrefillSchema.safeParse(details);
    if (!parsed.success) return;
    (storage ?? window.localStorage).setItem(SAVED_DETAILS_KEY, JSON.stringify(parsed.data));
  } catch {
    // Blocked or full storage: nothing is saved, which is fine.
  }
}

/**
 * The navigation state that opens the booking form at `/` filled with `prefill` ("הזמנה חדשה עם
 * אותם פרטים" on the customer page, section 9). Read back with {@link prefillFromNavigationState}.
 */
export function orderFormNavigationState(prefill: OrderPrefill): { orderPrefill: OrderPrefill } {
  return { orderPrefill: prefill };
}

/**
 * The prefill carried by a navigation state, or null for any other state (none, another page's,
 * or one whose details no longer parse). Validated with the schema: history state survives
 * reloads and app updates, so it is untrusted like storage.
 */
export function prefillFromNavigationState(state: unknown): OrderPrefill | null {
  if (typeof state !== 'object' || state === null || !('orderPrefill' in state)) return null;
  const parsed = orderPrefillSchema.safeParse(state.orderPrefill);
  return parsed.success ? parsed.data : null;
}

/**
 * The form's values for a prefill: the phone back in the local form customers type
 * (`050-1234567`), and the street as the picker holds it. A street code still in the official list
 * becomes that listed street (with its current official name); no code, or a code the list no
 * longer has, becomes the stored name as free text, so the customer still sees their street and
 * the order goes to Yoel without a region. The number of bottles and the honeypot start empty.
 */
export function formValuesFromPrefill(prefill: OrderPrefill): OrderFormValues {
  const { contact, address } = prefill;
  const street = address.streetCode === undefined ? undefined : findStreet(address.streetCode);
  return {
    name: contact.name,
    phone: formatIsraeliMobileLocal(contact.phone),
    street:
      street === undefined
        ? { kind: 'freeText', name: address.streetName }
        : { kind: 'listed', code: street.code, name: street.name },
    houseNumber: address.houseNumber,
    bottlesSpot: address.bottlesSpot,
    floorApt: address.floorApt ?? '',
    note: address.note ?? '',
    bottlesEstimated: '',
    website: '',
  };
}
