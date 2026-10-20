// The pure parts of Yoel's add and edit screens (spec §3.5, AddOrderScreen.tsx and
// EditOrderScreen.tsx): the edit form's starting values from a loaded order, the PATCH body put
// together from what he changed, and what each refused answer shows. No React here, so each rule
// is tested on its own.
import {
  findStreet,
  type AddOrderRequest,
  type CollectorOrder,
  type Region,
  type UpdateOrderRequest,
} from '@bottlerun/shared';
import type { CollectorOrderWriteOutcome } from '../api.ts';
import {
  SAVE_FAILED_MESSAGE,
  type FormErrors,
  type OrderFormValues,
} from '../orderForm/formValues.ts';
import { formValuesFromPrefill } from '../orderForm/savedDetails.ts';
import type { StreetChoice } from '../streetPicker/streetChoice.ts';

/** The orders list: where a saved add, edit or cancel returns, and where "חזרה להזמנות" leads. */
export const ORDERS_LIST_PATH = '/app/orders';

// Shown above the save button when a save got no usable answer. Defined with the form, which the
// customer's own "שינוי" shares; exported here too for this screen's tests.
export { SAVE_FAILED_MESSAGE };

/** Shown in the cancel confirmation when the cancel got no usable answer. */
export const CANCEL_FAILED_MESSAGE = 'לא הצלחנו לבטל. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/**
 * A write's answer that keeps Yoel on the screen. The other two leave it: `saved` returns to the
 * orders list, `loggedOut` goes to the login.
 */
export type StayingWriteOutcome = Exclude<
  CollectorOrderWriteOutcome,
  { kind: 'saved' } | { kind: 'loggedOut' }
>;

/**
 * The edit form's values for a loaded order: contact and address as the booking form's prefill
 * shows them (the phone as `050-1234567`, a street still in the list as that listed street, any
 * other as the stored name in free text), plus the number of bottles as text in its input.
 */
export function formValuesFromOrder(order: CollectorOrder): OrderFormValues {
  return {
    ...formValuesFromPrefill({ contact: order.contact, address: order.address }),
    bottlesEstimated: String(order.bottlesEstimated),
  };
}

/**
 * The "רחוב קרוב" picker's starting value: the order's near street as a listed street, or null
 * when it has none. A code that has since left the street list has no name to show: null too,
 * and saving then removes it (see {@link editRequest}), which is right, since the api would refuse
 * a code no longer in the list.
 */
export function nearStreetChoice(nearStreetCode: number | undefined): StreetChoice | null {
  if (nearStreetCode === undefined) return null;
  const street = findStreet(nearStreetCode);
  return street === undefined ? null : { kind: 'listed', code: street.code, name: street.name };
}

/**
 * The PATCH body of "שמירת השינויים" (`updateOrderRequestSchema`, which documents the api's side):
 *
 * - `contact`, `address` and `bottlesEstimated` always, from the validated form: the form shows
 *   them all, and sending an unchanged value changes nothing (the api re-derives the region only
 *   when a street code actually changes).
 * - `nearStreetCode` only when it differs from the stored one: the code of the street picked, or
 *   `null` to remove the stored one. Leaving it out keeps the stored one. `nearStreet` comes from
 *   a picker without free text, so a `freeText` value cannot happen; it would count as none.
 * - `region` only when Yoel picked one different from the stored one. An explicit region wins on
 *   the api, so sending the unchanged region would override what a newly picked near street sets
 *   (ADR-0005: the near street sets both region and map point, one action instead of two).
 */
export function editRequest(
  order: CollectorOrder,
  details: AddOrderRequest,
  nearStreet: StreetChoice | null,
  region: Region | undefined,
): UpdateOrderRequest {
  const request: UpdateOrderRequest = {
    contact: details.contact,
    address: details.address,
    bottlesEstimated: details.bottlesEstimated,
  };
  const nearStreetCode = nearStreet?.kind === 'listed' ? nearStreet.code : null;
  if (nearStreetCode !== (order.address.nearStreetCode ?? null)) {
    request.nearStreetCode = nearStreetCode;
  }
  if (region !== undefined && region !== order.region) request.region = region;
  return request;
}

/**
 * The errors a save's answer shows on the form (the add and the edit screen alike). Every one of
 * them keeps what Yoel typed, so he fixes one thing and saves again:
 * - `invalid`: next to the fields the api named; a path no field shows (`nearStreetCode`,
 *   `region`) is already in `other`, above the save button.
 * - `duplicate`: next to the phone, not above the form: the number is what he can check.
 * - `closed`, `notFound`: the message above the save button; the form cannot fix either.
 * - `failed`: {@link SAVE_FAILED_MESSAGE}; nothing is retried, since the save may have arrived.
 */
export function saveErrors(outcome: StayingWriteOutcome): FormErrors {
  switch (outcome.kind) {
    case 'invalid':
      return outcome.errors;
    case 'duplicate':
      return { byField: { phone: outcome.message } };
    case 'closed':
    case 'notFound':
      return { byField: {}, other: outcome.message };
    case 'failed':
      return { byField: {}, other: SAVE_FAILED_MESSAGE };
  }
}

/**
 * The message a cancel's answer shows in its confirmation: `closed` (already collected) and
 * `notFound` say why in their own words; anything else is {@link CANCEL_FAILED_MESSAGE}. The cancel
 * has no body, so `invalid` and `duplicate` never come; if one did, saying "try again" is honest.
 */
export function cancelErrorMessage(outcome: StayingWriteOutcome): string {
  switch (outcome.kind) {
    case 'closed':
    case 'notFound':
      return outcome.message;
    case 'invalid':
    case 'duplicate':
    case 'failed':
      return CANCEL_FAILED_MESSAGE;
  }
}
