// Israeli mobile numbers: what the booking form accepts and how the number is stored. Every
// phone is stored in one form, E.164 (+9725XXXXXXXX), so the one-open-order-per-phone rule
// (spec §3.1) catches "050-1234567" and "+972 50 123 4567" as the same customer, and the wa.me
// link (ADR-0003) can be built from it without parsing again.
import { z } from 'zod';

/** Plain-Hebrew error shown next to the phone field for any number the form cannot accept. */
export const PHONE_ERROR = 'מספר נייד לא תקין. למשל: 050-1234567';

// Removed anywhere in the input before matching: spaces (also the no-break space \s covers),
// hyphens and the dash characters a phone keyboard or autocorrect may insert, dots,
// parentheses, and the invisible direction marks (LRM, RLM, embeddings) that a number picks up
// when it is copied out of Hebrew text. `+` is not a separator: it may only open the number.
const PHONE_SEPARATORS = /[-\s\u{2010}-\u{2015}.()\u{200e}\u{200f}\u{202a}-\u{202e}]/gu;

// Local form: trunk 0 + 5 + 8 digits = 10 digits ("05X, 10 ספרות", spec §3.1). Every 05X
// prefix counts as mobile; landlines (02, 03, 04, 08, 09) and 07X numbers do not start with 05.
const LOCAL_MOBILE = /^0(5\d{8})$/;

// International form: +972, 00972 or a bare 972, then the subscriber number. The 0 after the
// country code is wrong but common ("+972 050-123-4567", "+972 (0)50…"), so it is tolerated.
const INTERNATIONAL_MOBILE = /^(?:\+|00)?9720?(5\d{8})$/;

/** A stored phone: already normalized, so only the exact E.164 mobile shape is valid. */
const E164_MOBILE = /^\+9725\d{8}$/;

/**
 * Normalizes an Israeli mobile number, as a customer types it, to E.164 (`+9725XXXXXXXX`).
 *
 * Accepts the local form `05X…` (10 digits) and the international forms `+972…`, `00972…` and
 * `972…`, also with the trunk 0 kept after the country code, with any spaces, hyphens, dots or
 * parentheses in between. Returns null for anything else: landlines, wrong lengths, letters,
 * an empty string.
 */
export function normalizeIsraeliMobile(input: string): string | null {
  const compact = input.replace(PHONE_SEPARATORS, '');
  const subscriber = LOCAL_MOBILE.exec(compact)?.[1] ?? INTERNATIONAL_MOBILE.exec(compact)?.[1];
  return subscriber === undefined ? null : `+972${subscriber}`;
}

/**
 * The phone field of the booking form (and of an order Yoel adds by hand): parses what was
 * typed and outputs the E.164 number to store. Every failure, including a missing field, is
 * one issue with {@link PHONE_ERROR}, so the form shows one plain sentence next to the field.
 * No `.trim()` needed: normalization removes whitespace anywhere in the number.
 */
export const israeliMobileSchema = z.string({ error: PHONE_ERROR }).transform((input, ctx) => {
  const e164 = normalizeIsraeliMobile(input);
  if (e164 === null) {
    ctx.addIssue({ code: 'custom', message: PHONE_ERROR });
    return z.NEVER;
  }
  return e164;
});

/**
 * A phone as stored in an order (read back from Mongo): must already be E.164 mobile. No
 * normalization here: a stored number in any other shape is a bug to surface, not to fix.
 */
export const e164MobileSchema = z
  .string()
  .regex(E164_MOBILE, 'expected an E.164 Israeli mobile number (+9725XXXXXXXX)');
