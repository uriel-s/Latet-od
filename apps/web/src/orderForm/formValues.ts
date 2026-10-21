// The booking form's values as its inputs hold them (spec §3.1), and the step from those values
// to the POST /api/orders body, to the order details Yoel's add and edit screens send (spec
// §3.5: same fields, same rules), or to the customer's "שינוי" on their own page (spec §3.3: the
// address and the bottles, never the phone). The rules themselves live in the shared schemas
// (`orderFormSchema`, `customerUpdateOrderRequestSchema`): this module only shapes the values into
// the schema's input and maps its errors back onto fields, so the form and the api can never
// disagree about what is valid.
import {
  MIN_BOTTLES,
  ORDER_HONEYPOT_FIELD,
  customerUpdateOrderRequestSchema,
  formFieldErrors,
  orderFormSchema,
  type AddOrderRequest,
  type AddressPlace,
  type BottlesSpot,
  type CreateOrderRequest,
  type CustomerUpdateOrderRequest,
} from '@bottlerun/shared';
import type { StreetChoice } from '../streetPicker/streetChoice.ts';

/**
 * The form's fields as the inputs hold them: text as typed, the street as the picker holds it,
 * `''` for "not chosen yet". `website` is the hidden honeypot input (`ORDER_HONEYPOT_FIELD`):
 * a person never sees it, so it stays empty unless a bot fills it.
 */
export interface OrderFormValues {
  name: string;
  phone: string;
  street: StreetChoice | null;
  houseNumber: string;
  bottlesSpot: BottlesSpot | '';
  /** Shown, and sent, only when `bottlesSpot` is `apartmentDoor`. */
  floorApt: string;
  note: string;
  bottlesEstimated: string;
  website: string;
}

/** The values of a blank form: nothing typed, no street, no "איפה הבקבוקים" chosen. */
export function emptyOrderFormValues(): OrderFormValues {
  return {
    name: '',
    phone: '',
    street: null,
    houseNumber: '',
    bottlesSpot: '',
    floorApt: '',
    note: '',
    bottlesEstimated: '',
    website: '',
  };
}

/** A field that can show an error next to it. The honeypot is not one: it is never shown. */
export type OrderFormField =
  | 'name'
  | 'phone'
  | 'street'
  | 'houseNumber'
  | 'bottlesSpot'
  | 'floorApt'
  | 'note'
  | 'bottlesEstimated';

/** Errors to show on the form: one plain-Hebrew message per field, plus one above the form. */
export interface FormErrors {
  byField: Partial<Record<OrderFormField, string>>;
  /** Set when a key no field shows came back. */
  other?: string;
}

/** No error anywhere: the form as it opens, and while a request is on its way. */
export const NO_ERRORS: FormErrors = { byField: {} };

/**
 * Shown above the form when an error cannot be placed next to a field (a path the form does not
 * know, or a failure with no field at all). Never dropped silently: the customer would press
 * "send" and see nothing happen.
 */
export const UNKNOWN_FIELD_ERROR = 'יש פרט שלא מולא נכון. נא לבדוק את הטופס ולנסות שוב.';

/**
 * Shown above the save button of a form that changes an order (Yoel's edit, the customer's
 * "שינוי") when the save got no usable answer (network error, 5xx). What was typed stays.
 */
export const SAVE_FAILED_MESSAGE = 'לא הצלחנו לשמור. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

// Dotted paths of the shared schema's issues (and of the api's 400 `fieldErrors`) → form field.
// Both street paths land on the one street picker. A Map, so a key such as "__proto__" is just
// an unknown path and never reaches an object's prototype.
const FIELD_BY_PATH: ReadonlyMap<string, OrderFormField> = new Map<string, OrderFormField>([
  ['contact.name', 'name'],
  ['contact.phone', 'phone'],
  ['address.streetCode', 'street'],
  ['address.streetName', 'street'],
  ['address.houseNumber', 'houseNumber'],
  ['address.bottlesSpot', 'bottlesSpot'],
  ['address.floorApt', 'floorApt'],
  ['address.note', 'note'],
  ['bottlesEstimated', 'bottlesEstimated'],
]);

/**
 * True when the bottles field holds a whole number of at least {@link MIN_BOTTLES}. The booking
 * form greys its send button until then. Only a hint for the customer: the schema still decides
 * what is valid, and its message shows when the button is tapped anyway. It ignores the maximum:
 * 6000 looks ready, and the "too many" message shows on the tap.
 */
export function hasEnoughBottles(bottlesEstimated: string): boolean {
  return /^\d+$/.test(bottlesEstimated.trim()) && Number(bottlesEstimated) >= MIN_BOTTLES;
}

/**
 * Maps `{ dottedPath: message }` (from `formFieldErrors`, or the api's 400 body) onto the form's
 * fields. The first message for a field wins, so the street shows one sentence even when both
 * its paths failed. Any path the form does not know, and an empty map (a failure with no field
 * to show it), set `other` to {@link UNKNOWN_FIELD_ERROR} instead of being lost.
 */
export function mapFieldErrors(fieldErrors: Record<string, string>): FormErrors {
  const byField: Partial<Record<OrderFormField, string>> = {};
  let unplaced = false;
  for (const [path, message] of Object.entries(fieldErrors)) {
    const field = FIELD_BY_PATH.get(path);
    if (field === undefined) {
      unplaced = true;
    } else if (byField[field] === undefined) {
      byField[field] = message;
    }
  }
  // Only ever called for a failure: a failure that shows nothing would leave the customer stuck.
  if (Object.keys(byField).length === 0) unplaced = true;
  return unplaced ? { byField, other: UNKNOWN_FIELD_ERROR } : { byField };
}

/** The address as the schema reads it; `bottlesSpot` is absent until one is chosen. */
interface RawAddress {
  streetCode?: number;
  streetName?: string;
  houseNumber: string;
  bottlesSpot?: BottlesSpot;
  floorApt?: string;
  note: string;
}

/**
 * The address fields in the shape the shared `addressInputSchema` reads, for every form: the
 * booking form, Yoel's screens and the customer's "שינוי". Fields are left out, not sent empty,
 * where an absent field is what makes the schema give the right plain message ("נא לבחור איפה
 * הבקבוקים", "נא לבחור רחוב או לכתוב אותו").
 */
function toRawAddress(values: OrderFormValues): RawAddress {
  const address: RawAddress = { houseNumber: values.houseNumber, note: values.note };
  // A listed street sends its code (the api takes the official name from it) and its name; a
  // street written by hand sends only the name, which gives the order no region ("בלי אזור").
  if (values.street?.kind === 'listed') {
    address.streetCode = values.street.code;
    address.streetName = values.street.name;
  } else if (values.street?.kind === 'freeText') {
    address.streetName = values.street.name;
  }
  if (values.bottlesSpot !== '') address.bottlesSpot = values.bottlesSpot;
  // The floor and apartment field is hidden for any other spot, but keeps what was typed in it
  // before the customer changed their answer; that stale text must not be sent and stored.
  if (values.bottlesSpot === 'apartmentDoor') address.floorApt = values.floorApt;
  return address;
}

/** The values in the shape the shared `orderFormSchema` reads (see {@link toRawAddress}). */
function toRawForm(values: OrderFormValues) {
  return {
    contact: { name: values.name, phone: values.phone },
    address: toRawAddress(values),
    bottlesEstimated: values.bottlesEstimated,
  };
}

/**
 * Validates the order's details with the shared `orderFormSchema`, the same check the api runs,
 * so every mistake shows next to its field before anything is sent. The booking form uses it
 * through {@link validateOrderForm}; Yoel's add and edit screens use it as is, since their
 * requests carry no honeypot (an `AddOrderRequest`, or the contact, address and bottles of an
 * `UpdateOrderRequest`).
 *
 * On success, `request` is the schema's output (trimmed text, the phone in E.164, the official
 * street name, the number of bottles as a number), which is valid input to the same schema.
 * `values.website` is ignored.
 */
export function validateOrderDetails(
  values: OrderFormValues,
): { ok: true; request: AddOrderRequest } | { ok: false; errors: FormErrors } {
  const parsed = orderFormSchema.safeParse(toRawForm(values));
  if (!parsed.success) {
    return { ok: false, errors: mapFieldErrors(formFieldErrors(parsed.error)) };
  }
  return { ok: true, request: parsed.data };
}

/**
 * Validates the public booking form: {@link validateOrderDetails} before anything is sent, so the
 * customer sees every mistake next to its field before the request counts toward the per-IP limit.
 *
 * On success, `request` is the validated details plus the honeypot exactly as the hidden input
 * holds it: the api decides what a filled one means.
 */
export function validateOrderForm(
  values: OrderFormValues,
): { ok: true; request: CreateOrderRequest } | { ok: false; errors: FormErrors } {
  const validation = validateOrderDetails(values);
  if (!validation.ok) return validation;
  return { ok: true, request: { ...validation.request, [ORDER_HONEYPOT_FIELD]: values.website } };
}

/**
 * Validates the customer's "שינוי" on their own page (spec §3.3: "אפשר לשנות כתובת, כמות והערה.
 * לא את הטלפון.") with the shared `customerUpdateOrderRequestSchema`, the same check PATCH
 * /api/o/:token runs, so every mistake shows next to its field before anything is sent.
 *
 * The request always has `address` (the note is part of it) and `bottlesEstimated`, both from
 * the form; sending an unchanged value changes nothing. It NEVER has `contact`, whatever the name
 * and phone values hold: the phone cannot be changed there, and the api refuses a body with a
 * `contact` key as a whole (400). On success, `request` is the schema's output (trimmed text, the
 * official street name, the number of bottles as a number), which is valid input to the same
 * schema.
 */
export function validateCustomerChange(
  values: OrderFormValues,
): { ok: true; request: CustomerUpdateOrderRequest } | { ok: false; errors: FormErrors } {
  const parsed = customerUpdateOrderRequestSchema.safeParse({
    address: toRawAddress(values),
    bottlesEstimated: values.bottlesEstimated,
  });
  if (!parsed.success) {
    return { ok: false, errors: mapFieldErrors(formFieldErrors(parsed.error)) };
  }
  return { ok: true, request: parsed.data };
}

/**
 * Where the form's address says the house is, compared with the stored address by the shared
 * `isLocationChange` (the customer page's warning that a new address takes the order out of its
 * round). Compared like the api compares it: a listed street as its code and official name, a
 * street written by hand as its trimmed name, the house number trimmed. No street chosen yet (the
 * customer is retyping it) is an empty name, so it counts as a change.
 */
export function addressPlaceOf(values: OrderFormValues): AddressPlace {
  const houseNumber = values.houseNumber.trim();
  switch (values.street?.kind) {
    case 'listed':
      return { streetCode: values.street.code, streetName: values.street.name, houseNumber };
    case 'freeText':
      return { streetName: values.street.name.trim(), houseNumber };
    case undefined:
      return { streetName: '', houseNumber };
  }
}
