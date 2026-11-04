// UI language and translated text. The app is Hebrew first; English is an optional second
// language for customers who do not read Hebrew. No i18n library on purpose (zero cost, minimum
// moving parts): a dictionary is a plain object per language, and the type system makes every
// language carry exactly the same keys, so a missing translation fails `tsc`, not a customer.
import { z } from 'zod';

/** A language the UI speaks: `he` = Hebrew (right-to-left), `en` = English (left-to-right). */
export const langSchema = z.enum(['he', 'en']);
export type Lang = z.infer<typeof langSchema>;

/**
 * The language when none was chosen. Hebrew: the app was built for Hebrew speakers, and an order
 * stored before languages existed has no `lang` and reads as Hebrew.
 */
export const DEFAULT_LANG: Lang = 'he';

/**
 * Texts by language, then by key. Every language has exactly the keys `K`: a key missing from one
 * language is a type error, and so is an extra key in one language's object literal (excess
 * property check). Texts may hold `{name}` placeholders, filled by {@link translate}.
 */
export type Dictionary<K extends string> = Readonly<Record<Lang, Readonly<Record<K, string>>>>;

/** Values for a text's `{name}` placeholders. Numbers are inserted with `String(value)`. */
export type TranslationVars = Readonly<Record<string, string | number>>;

/** One `{name}` placeholder: a word in braces. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The text of `key` in `lang`, with every `{name}` placeholder replaced by `vars[name]`.
 *
 * A placeholder with no value in `vars` stays as written (`{name}`) instead of throwing: a missing
 * value is a bug to see on screen, not a crash of the whole page. Values are inserted literally
 * in one pass, so a value that itself contains `{x}` is not substituted again.
 */
export function translate<K extends string>(
  dictionary: Dictionary<K>,
  lang: Lang,
  key: K,
  vars?: TranslationVars,
): string {
  const text = dictionary[lang][key];
  if (vars === undefined) return text;
  return text.replace(PLACEHOLDER, (placeholder, name: string) =>
    // Object.hasOwn, not `name in vars`: `{toString}` must not pick up Object.prototype.toString.
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  );
}

// ---------------------------------------------------------------------------------------------
// The app's dictionary
// ---------------------------------------------------------------------------------------------
//
// HOW TO ADD A TEXT: add the key with its Hebrew text to HE, then the same key to EN. HE is the
// source of the key list (MessageKey); EN must satisfy Record<MessageKey, string>, so forgetting
// the English text, or an English-only key, fails `tsc`. Keep keys grouped by screen with a short
// comment, e.g. `formTitle: 'הזמנת איסוף בקבוקים'`. Keys are dotted by group
// (`formError.nameRequired`), so code can build a key from a value: `orderStatus.${status}`.
//
// Some Hebrew texts below are copies of older Hebrew constants that the api and zod still use
// (APP_SLOGAN, ORDER_FORM_ERRORS, BOTTLES_SPOT_LABELS, ORDER_STATUS_LABELS, CREATE_ORDER_MESSAGES,
// CUSTOMER_ORDER_MESSAGES). Copied, not imported: order.ts imports this module at load time, so
// importing back from it would be circular. i18n.test.ts checks that every copy is identical to
// its constant, so change both together.

/** Hebrew texts. Its keys define {@link MessageKey}. */
const HE = {
  // The slogan under the app's name (index.ts APP_SLOGAN).
  appSlogan: 'הבקבוקים שלכם, התפילין שלהם!',

  // Booking-form field messages (order.ts ORDER_FORM_ERRORS). {min} is MIN_BOTTLES.
  'formError.nameRequired': 'נא לכתוב שם',
  'formError.nameTooLong': 'השם ארוך מדי',
  'formError.streetRequired': 'נא לבחור רחוב או לכתוב אותו',
  'formError.streetNotFound': 'הרחוב לא נמצא ברשימה',
  'formError.streetTooLong': 'שם הרחוב ארוך מדי',
  'formError.houseNumberRequired': 'נא לכתוב מספר בית',
  'formError.houseNumberInvalid': 'מספר הבית צריך להתחיל בספרה, למשל 12 או 12א',
  'formError.houseNumberTooLong': 'מספר הבית ארוך מדי',
  'formError.bottlesSpotRequired': 'נא לבחור איפה הבקבוקים',
  'formError.floorAptRequired': 'נא לכתוב קומה ודירה',
  'formError.floorAptTooLong': 'הטקסט ארוך מדי',
  'formError.noteInvalid': 'ההערה לא תקינה',
  'formError.noteTooLong': 'ההערה ארוכה מדי',
  'formError.bottlesRequired': 'נא לכתוב מספר בקבוקים',
  'formError.bottlesTooFew': 'צריך לפחות {min} בקבוקים',
  'formError.bottlesTooMany': 'המספר גדול מדי, נא לבדוק',

  // Where the bottles wait (order.ts BOTTLES_SPOT_LABELS).
  'bottlesSpot.privateHouse': 'בכניסה לבית פרטי',
  'bottlesSpot.apartmentDoor': 'בבניין - ליד דלת הדירה',
  'bottlesSpot.buildingEntrance': 'למטה בכניסה לבניין',

  // Order status names (orderStatus.ts ORDER_STATUS_LABELS).
  'orderStatus.waiting': 'ממתינה לסבב',
  'orderStatus.pending': 'ממתינה לאישור',
  'orderStatus.confirmed': 'אושרה',
  'orderStatus.collected': 'נאספה',
  'orderStatus.cancelled': 'בוטלה',

  // POST /api/orders messages above the form (orderApi.ts CREATE_ORDER_MESSAGES).
  'createOrder.duplicateOpenOrder': 'כבר יש הזמנה פתוחה למספר הזה.',
  'createOrder.rateLimited': 'יותר מדי ניסיונות. נא לנסות שוב מאוחר יותר.',

  // The customer's page (customerOrderApi.ts CUSTOMER_ORDER_MESSAGES).
  'customerOrder.confirmationsClosed': 'האישור נסגר. נחזור אליך עם מועד חדש.',
  'customerOrder.orderClosed': 'ההזמנה כבר נסגרה, ואי אפשר לשנות אותה.',
  'customerOrder.orderNotFound': 'לא מצאנו את ההזמנה. ייתכן שהקישור לא הועתק עד הסוף.',
} as const satisfies Record<string, string>;

/** A key of the app's dictionary. */
export type MessageKey = keyof typeof HE;

/** English texts: the same keys as {@link HE}, no more and no fewer. */
const EN = {
  appSlogan: 'Your bottles, their tefillin!',

  // Booking-form field messages.
  'formError.nameRequired': 'Please write your name',
  'formError.nameTooLong': 'The name is too long',
  'formError.streetRequired': 'Please choose a street or type it',
  'formError.streetNotFound': 'This street is not on the list',
  'formError.streetTooLong': 'The street name is too long',
  'formError.houseNumberRequired': 'Please write a house number',
  'formError.houseNumberInvalid':
    'The house number should start with a digit, for example 12 or 12A',
  'formError.houseNumberTooLong': 'The house number is too long',
  'formError.bottlesSpotRequired': 'Please choose where the bottles are',
  'formError.floorAptRequired': 'Please write the floor and apartment',
  'formError.floorAptTooLong': 'The text is too long',
  'formError.noteInvalid': 'The note is not valid',
  'formError.noteTooLong': 'The note is too long',
  'formError.bottlesRequired': 'Please write the number of bottles',
  'formError.bottlesTooFew': 'At least {min} bottles are needed',
  'formError.bottlesTooMany': 'The number is too large, please check',

  // Where the bottles wait.
  'bottlesSpot.privateHouse': 'At the entrance of a private house',
  'bottlesSpot.apartmentDoor': 'In a building - by the apartment door',
  'bottlesSpot.buildingEntrance': 'Downstairs at the building entrance',

  // Order status names.
  'orderStatus.waiting': 'Waiting for a round',
  'orderStatus.pending': 'Waiting for confirmation',
  'orderStatus.confirmed': 'Confirmed',
  'orderStatus.collected': 'Collected',
  'orderStatus.cancelled': 'Cancelled',

  // POST /api/orders messages above the form.
  'createOrder.duplicateOpenOrder': 'There is already an open order for this number.',
  'createOrder.rateLimited': 'Too many attempts. Please try again later.',

  // The customer's page.
  'customerOrder.confirmationsClosed':
    'Confirmation is closed. We will get back to you with a new date.',
  'customerOrder.orderClosed': 'This order is already closed and cannot be changed.',
  'customerOrder.orderNotFound':
    'We could not find the order. The link may not have been copied in full.',
} as const satisfies Record<MessageKey, string>;

/** The app's dictionary: every UI text in every {@link Lang}. Read it through {@link t}. */
export const MESSAGES: Dictionary<MessageKey> = { he: HE, en: EN };

/** The app text of `key` in `lang`, placeholders filled from `vars` (see {@link translate}). */
export function t(lang: Lang, key: MessageKey, vars?: TranslationVars): string {
  return translate(MESSAGES, lang, key, vars);
}
