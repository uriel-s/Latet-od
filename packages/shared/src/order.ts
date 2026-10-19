// Orders (spec §5, as changed by ADR-0003 and ADR-0005). Two shapes on purpose:
// - orderSchema: an order as the api reads it from Mongo and returns it as JSON. It checks
//   structure only, with no cross-field form rules, so a stored order stays readable.
// - orderFormSchema: the booking form (spec §3.1). The web form, POST /api/orders and Yoel's
//   "הוספת הזמנה" all validate with it, so the rules (at least 30 bottles, floor and apartment
//   when the bottles wait at the apartment door) are written once, with plain-Hebrew messages.
import { z } from 'zod';
import { israeliMobileSchema, e164MobileSchema } from './phone.ts';
import { orderStatusSchema } from './orderStatus.ts';
import { findStreet, regionSchema } from './streets.ts';

// ---------------------------------------------------------------------------------------------
// Limits and messages
// ---------------------------------------------------------------------------------------------

/** Fewest bottles an order may have (spec §3.1): a hard rule of Yoel's (ת8). */
export const MIN_BOTTLES = 30;

/** Most bottles an order may have. No real order comes near it: it catches a typo like 30000. */
export const MAX_BOTTLES = 5000;

/**
 * Longest text the booking form accepts per field, after trimming. Generous for anything a
 * customer really types; they stop a pasted essay. The web form can use them as `maxLength`.
 */
export const FORM_TEXT_MAX_LENGTH = {
  name: 60,
  streetName: 60,
  houseNumber: 10,
  floorApt: 60,
  note: 200,
} as const;

/**
 * Plain-Hebrew messages of the booking form. Each is shown next to its field, so it says what to
 * do in a few words: most customers are elderly (spec §3.1, ת9).
 */
export const ORDER_FORM_ERRORS = {
  nameRequired: 'נא לכתוב שם',
  nameTooLong: 'השם ארוך מדי',
  streetRequired: 'נא לבחור רחוב או לכתוב אותו',
  streetNotFound: 'הרחוב לא נמצא ברשימה',
  streetTooLong: 'שם הרחוב ארוך מדי',
  houseNumberRequired: 'נא לכתוב מספר בית',
  houseNumberInvalid: 'מספר הבית צריך להתחיל בספרה, למשל 12 או 12א',
  houseNumberTooLong: 'מספר הבית ארוך מדי',
  bottlesSpotRequired: 'נא לבחור איפה הבקבוקים',
  floorAptRequired: 'נא לכתוב קומה ודירה',
  floorAptTooLong: 'הטקסט ארוך מדי',
  noteInvalid: 'ההערה לא תקינה',
  noteTooLong: 'ההערה ארוכה מדי',
  bottlesRequired: 'נא לכתוב מספר בקבוקים',
  bottlesTooFew: `צריך לפחות ${MIN_BOTTLES} בקבוקים`,
  bottlesTooMany: 'המספר גדול מדי, נא לבדוק',
} as const;

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

/**
 * Where the customer leaves the bottles (spec §3.1). In buildings some customers bring them down
 * and some need Yoel to come up (ת4); only `apartmentDoor` needs a floor and apartment.
 */
export const bottlesSpotSchema = z.enum(['privateHouse', 'apartmentDoor', 'buildingEntrance']);
export type BottlesSpot = z.infer<typeof bottlesSpotSchema>;

/** The form's answers to "איפה הבקבוקים", as the customer and Yoel see them. */
export const BOTTLES_SPOT_LABELS: Readonly<Record<BottlesSpot, string>> = {
  privateHouse: 'בכניסה לבית פרטי',
  apartmentDoor: 'ליד דלת הדירה',
  buildingEntrance: 'למטה בכניסה לבניין',
};

/**
 * Why an order left a round without being collected (spec §4, "יציאה מסבב"). A reason, not a
 * status: the order goes back to `waiting` and `lastMiss` keeps the reason for its tag.
 */
export const missReasonSchema = z.enum([
  'notConfirmed',
  'askedOtherDate',
  'notFound',
  'notReached',
  'addressChanged',
]);
export type MissReason = z.infer<typeof missReasonSchema>;

/** Hebrew text of each reason, shown in the tag of an order back from a round ("לא אישר · 12/11"). */
export const MISS_REASON_LABELS: Readonly<Record<MissReason, string>> = {
  notConfirmed: 'לא אישר בזמן',
  askedOtherDate: 'ביקש מועד אחר',
  notFound: 'לא נמצא במקום',
  notReached: 'לא הגענו אליו',
  addressChanged: 'שינה כתובת',
};

/** Who created the order: the customer through the public form, or Yoel ("הוספת הזמנה"). */
export const orderSourceSchema = z.enum(['form', 'collector']);
export type OrderSource = z.infer<typeof orderSourceSchema>;

/**
 * How Yoel reaches the customer. The MVP has only `whatsapp`; the field is stored anyway so that
 * customers without WhatsApp (kosher phones) can be added later without a migration (spec §1).
 */
export const contactMethodSchema = z.enum(['whatsapp']);
export type ContactMethod = z.infer<typeof contactMethodSchema>;

/** The two WhatsApp messages an order gets (ADR-0003): asking to confirm a round, and thanks. */
export const messageKindSchema = z.enum(['confirmRequest', 'thankYou']);
export type MessageKind = z.infer<typeof messageKindSchema>;

// ---------------------------------------------------------------------------------------------
// Stored order
// ---------------------------------------------------------------------------------------------

/**
 * A point in time. The same schema reads a Mongo document (a `Date`) and an api JSON response
 * (the ISO string `JSON.stringify` writes for a Date), because zod in shared is the single source
 * of the data's shape for both. Not `z.coerce.date()`: it turns `null` into 1 January 1970 and
 * accepts any number, so a broken document would read as a wrong date instead of failing.
 */
export const timestampSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((iso) => new Date(iso)),
]);

/**
 * An order's address as stored. Only structure is checked here; the form rules (street in the
 * list, floor and apartment for the apartment door, lengths) live in {@link addressInputSchema}
 * and are checked when the address is written.
 */
export const addressSchema = z.object({
  /** Official street code from the list; absent when the customer wrote the street by hand. */
  streetCode: z.int().positive().optional(),
  /** The official name of `streetCode`, or the customer's free text when there is no code. */
  streetName: z.string().min(1),
  /**
   * "רחוב קרוב": a listed street Yoel picks for a free-text street (or one with no or a wrong
   * point). It sets both the region and the map point (ADR-0005). The customer never sets it.
   */
  nearStreetCode: z.int().positive().optional(),
  /** May carry a letter: "12א". */
  houseNumber: z.string().min(1),
  bottlesSpot: bottlesSpotSchema,
  /** One free line, e.g. "כניסה ב', קומה 3, דירה 12". */
  floorApt: z.string().optional(),
  note: z.string().optional(),
});
export type Address = z.infer<typeof addressSchema>;

/**
 * The last round the order left without being collected (spec §4). Only the latest is kept, not
 * a history: the tag shows one reason and one date.
 */
export const lastMissSchema = z.object({
  /** The round's calendar date (YYYY-MM-DD, Asia/Jerusalem), shown in the tag as DD/MM. */
  date: z.iso.date(),
  reason: missReasonSchema,
  roundId: z.string().min(1),
});
export type LastMiss = z.infer<typeof lastMissSchema>;

/** Fields every entry of an order's message log has: which message, and when it was handled. */
const messageLogBase = {
  kind: messageKindSchema,
  at: timestampSchema,
};

/**
 * One WhatsApp message in an order's log (ADR-0003). Mirrors `SendResult`, by `mode`:
 * - `sent`: sent automatically (Cloud API), with the provider's message id.
 * - `manual`: a wa.me link for Yoel to open and tap "send". `openedAt` is set when he opens it;
 *   nobody can know whether he then really sent it, so it never changes the order's status.
 * - `failed`: the sender failed, with the reason.
 *
 * ADR-0003 sketches the entry as `{ kind, at, mode, result }`; the result's fields sit directly
 * on the entry here, so each mode carries exactly its own fields.
 */
export const messageLogEntrySchema = z.discriminatedUnion('mode', [
  z.object({ ...messageLogBase, mode: z.literal('sent'), providerId: z.string().min(1) }),
  z.object({
    ...messageLogBase,
    mode: z.literal('manual'),
    // https only: the collector app puts this url in a link, so it must never be a javascript: url.
    url: z.url({ protocol: /^https$/ }),
    openedAt: timestampSchema.optional(),
  }),
  z.object({ ...messageLogBase, mode: z.literal('failed'), reason: z.string() }),
]);
export type MessageLogEntry = z.infer<typeof messageLogEntrySchema>;

/** Random bytes behind an order token: 256 bits, far beyond guessing. */
export const ORDER_TOKEN_BYTES = 32;

/**
 * The secret in the customer's link `/o/<token>` (spec §3.3): {@link ORDER_TOKEN_BYTES} random
 * bytes from node:crypto (generated by the api), base64url without padding, which is exactly 43
 * characters of [A-Za-z0-9_-] and needs no escaping in a URL. The customer page is reached only
 * by token, never by the guessable id.
 */
export const orderTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'expected 43 base64url characters');

/**
 * An order as the api reads it from Mongo and returns it (spec §5, with the ADR changes: no
 * `location`, which is derived from the street codes; `address.nearStreetCode`; one `lastMiss`;
 * the `messages` log). Unknown keys are stripped, so Mongo's `_id` does not leak: the repo maps it
 * to the hex `id`.
 */
export const orderSchema = z.object({
  id: z.string().min(1),
  contact: z.object({
    name: z.string().min(1),
    /** Always E.164, so one open order per phone (spec §3.1) compares like with like. */
    phone: e164MobileSchema,
    method: contactMethodSchema,
  }),
  address: addressSchema,
  bottlesEstimated: z.int().min(MIN_BOTTLES).max(MAX_BOTTLES),
  /** Filled in by Yoel on "אספתי"; it is what the monthly statistics count. */
  bottlesCollected: z.int().nonnegative().optional(),
  status: orderStatusSchema,
  /** Empty for a free-text street until Yoel assigns a region (spec §3.5). */
  region: regionSchema.optional(),
  token: orderTokenSchema,
  /** The round the order is in now, if any. */
  roundId: z.string().min(1).optional(),
  lastMiss: lastMissSchema.optional(),
  messages: z.array(messageLogEntrySchema),
  source: orderSourceSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  collectedAt: timestampSchema.optional(),
  cancelledAt: timestampSchema.optional(),
});
export type Order = z.infer<typeof orderSchema>;

/** An order before it is stored: what a repository's `create()` takes. The repo assigns `id`. */
export type NewOrder = Omit<Order, 'id'>;

// ---------------------------------------------------------------------------------------------
// Booking-form input
// ---------------------------------------------------------------------------------------------

const ERR = ORDER_FORM_ERRORS;

/**
 * An optional free-text field. A form sends '' for a field left empty, so blank text (also only
 * spaces) becomes absent instead of being stored as an empty string.
 */
function optionalFormText(maxLength: number, messages: { invalid: string; tooLong: string }) {
  return z
    .string({ error: messages.invalid })
    .trim()
    .max(maxLength, messages.tooLong)
    .transform((text) => (text === '' ? undefined : text))
    .optional();
}

/**
 * `when` for a cross-field check of the address: run it unless the address is not an object or
 * one of `fields` already failed. By default zod skips an object's refinements once any field
 * fails, so a customer who left the house number empty would see "נא לכתוב קומה ודירה" only after
 * fixing it. The form should show every mistake at once.
 */
function unlessFailed(...fields: readonly string[]): (payload: z.core.ParsePayload) => boolean {
  return (payload) =>
    payload.issues.every((issue) => {
      const field = issue.path?.[0];
      // An issue without a path is about the address itself (e.g. not an object): skip the check.
      return field !== undefined && !fields.some((name) => name === field);
    });
}

/** The address the form stores: the stored shape without `nearStreetCode`, which only Yoel sets. */
type FormAddress = Omit<Address, 'nearStreetCode'>;

/**
 * The address part of the booking form (spec §3.1). The street is either picked from the list
 * (`streetCode`) or written by hand ("הרחוב שלי לא ברשימה": `streetName` only). With a code, the
 * output's `streetName` is the official name, whatever name the client sent, so a stored code and
 * name always agree. "בלי אזור" for a free-text street is the api's to derive, not the form's.
 *
 * Text is trimmed; empty optional fields are left out of the output (not set to undefined: the
 * Mongo driver would store an undefined as null, which {@link addressSchema} rejects).
 */
export const addressInputSchema = z
  .object({
    streetCode: z
      .int({ error: ERR.streetNotFound })
      .refine((code) => findStreet(code) !== undefined, { error: ERR.streetNotFound })
      .optional(),
    // Optional here: with a streetCode it is replaced; without one the check below requires it.
    streetName: z
      .string({ error: ERR.streetRequired })
      .trim()
      .max(FORM_TEXT_MAX_LENGTH.streetName, ERR.streetTooLong)
      .optional(),
    houseNumber: z
      .string({ error: ERR.houseNumberRequired })
      .trim()
      .min(1, ERR.houseNumberRequired)
      .max(FORM_TEXT_MAX_LENGTH.houseNumber, ERR.houseNumberTooLong)
      // Lenient on purpose ("12א", "12/3", "12 ב"); it only has to start with the number.
      // An empty value already has its own message, so it is not reported twice.
      .refine((houseNumber) => houseNumber === '' || /^\d/.test(houseNumber), {
        error: ERR.houseNumberInvalid,
      }),
    bottlesSpot: z.enum(bottlesSpotSchema.options, { error: ERR.bottlesSpotRequired }),
    floorApt: optionalFormText(FORM_TEXT_MAX_LENGTH.floorApt, {
      invalid: ERR.floorAptRequired,
      tooLong: ERR.floorAptTooLong,
    }),
    note: optionalFormText(FORM_TEXT_MAX_LENGTH.note, {
      invalid: ERR.noteInvalid,
      tooLong: ERR.noteTooLong,
    }),
  })
  .refine((address) => address.streetCode !== undefined || (address.streetName ?? '') !== '', {
    error: ERR.streetRequired,
    path: ['streetName'],
    when: unlessFailed('streetCode', 'streetName'),
  })
  // Yoel has to know which door to go up to (spec §3.1).
  .refine((address) => address.bottlesSpot !== 'apartmentDoor' || address.floorApt !== undefined, {
    error: ERR.floorAptRequired,
    path: ['floorApt'],
    when: unlessFailed('bottlesSpot', 'floorApt'),
  })
  .transform((address): FormAddress => {
    const street = address.streetCode === undefined ? undefined : findStreet(address.streetCode);
    const stored: FormAddress = {
      // `?? ''` is for the type only: the refinement above already required one of the two.
      streetName: street?.name ?? address.streetName ?? '',
      houseNumber: address.houseNumber,
      bottlesSpot: address.bottlesSpot,
    };
    if (street !== undefined) stored.streetCode = street.code;
    if (address.floorApt !== undefined) stored.floorApt = address.floorApt;
    if (address.note !== undefined) stored.note = address.note;
    return stored;
  });

/**
 * Number of bottles as the form sends it. An `<input>` yields a string ("45"): digits become a
 * number, and anything else (blank, "abc", "4,5") is left for `z.int` to reject with a plain
 * message. Not `z.coerce.number()`: it turns a blank field into 0 ("at least 30" instead of
 * "write a number") and accepts "1e3".
 */
const bottlesEstimatedInputSchema = z.preprocess(
  (value) => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value),
  z
    .int({ error: ERR.bottlesRequired })
    .min(MIN_BOTTLES, ERR.bottlesTooFew)
    .max(MAX_BOTTLES, ERR.bottlesTooMany),
);

/**
 * The booking form (spec §3.1), also used by Yoel's "הוספת הזמנה" (same form, same rules, spec
 * §3.5). Output: trimmed text, the phone in E.164, the official street name, a whole number of
 * bottles. Unknown keys are stripped; the api reads its spam honeypot from the raw body, and sets
 * `contact.method`, status, token, region and dates itself.
 */
export const orderFormSchema = z.object({
  contact: z.object({
    name: z
      .string({ error: ERR.nameRequired })
      .trim()
      .min(1, ERR.nameRequired)
      .max(FORM_TEXT_MAX_LENGTH.name, ERR.nameTooLong),
    phone: israeliMobileSchema,
  }),
  address: addressInputSchema,
  bottlesEstimated: bottlesEstimatedInputSchema,
});

/** What the form sends: strings as typed, the number of bottles possibly as a string. */
export type OrderFormInput = z.input<typeof orderFormSchema>;
/** The form after validation: ready to become a {@link NewOrder}. */
export type OrderForm = z.output<typeof orderFormSchema>;
