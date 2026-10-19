// The booking form's values as its inputs hold them (spec §3.1), and the step from those values
// to the POST /api/orders body. The rules themselves live in the shared `orderFormSchema`: this
// module only shapes the values into the schema's input and maps its errors back onto fields, so
// the form and the api can never disagree about what is valid.
import {
  ORDER_HONEYPOT_FIELD,
  formFieldErrors,
  orderFormSchema,
  type BottlesSpot,
  type CreateOrderRequest,
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

/**
 * Shown above the form when an error cannot be placed next to a field (a path the form does not
 * know, or a failure with no field at all). Never dropped silently: the customer would press
 * "send" and see nothing happen.
 */
export const UNKNOWN_FIELD_ERROR = 'יש פרט שלא מולא נכון. נא לבדוק את הטופס ולנסות שוב.';

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
 * The values in the shape the shared schema reads. Fields are left out, not sent empty, where an
 * absent field is what makes the schema give the right plain message ("נא לבחור איפה הבקבוקים",
 * "נא לבחור רחוב או לכתוב אותו").
 */
function toRawForm(values: OrderFormValues) {
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
  return {
    contact: { name: values.name, phone: values.phone },
    address,
    bottlesEstimated: values.bottlesEstimated,
  };
}

/**
 * Validates the form with the shared `orderFormSchema`, the same check the api runs, so the
 * customer sees every mistake next to its field before anything is sent (and before the request
 * counts toward the per-IP limit).
 *
 * On success, `request` is the schema's output (trimmed text, the phone in E.164, the official
 * street name, the number of bottles as a number), which is valid input to the same schema, plus
 * the honeypot exactly as the hidden input holds it: the api decides what a filled one means.
 */
export function validateOrderForm(
  values: OrderFormValues,
): { ok: true; request: CreateOrderRequest } | { ok: false; errors: FormErrors } {
  const parsed = orderFormSchema.safeParse(toRawForm(values));
  if (!parsed.success) {
    return { ok: false, errors: mapFieldErrors(formFieldErrors(parsed.error)) };
  }
  return { ok: true, request: { ...parsed.data, [ORDER_HONEYPOT_FIELD]: values.website } };
}
