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

  // WhatsApp messages (messages.ts renderMessage, spec §6.1), one key per line of the message.
  // {name} is the customer's trimmed name, {date} the round's day and {from}/{by} the pickup times,
  // already formatted for the language. The Hebrew must stay exactly as sent before English
  // existed: messages.test.ts compares whole messages char for char.
  'whatsapp.greeting': 'שלום {name},',
  'whatsapp.confirmRequest.date': 'ב-{date} נעבור לאסוף את הבקבוקים שלכם.',
  'whatsapp.confirmRequest.pickupWindow': 'נא להוציא את הבקבוקים בין השעות {from} ל-{by}.',
  'whatsapp.confirmRequest.pickupBy': 'נא להוציא את הבקבוקים עד השעה {by}.',
  'whatsapp.confirmRequest.confirmAtLink': 'נא לאשר את האיסוף בקישור:',
  // Ends with the app's name (index.ts APP_NAME); messages.test.ts checks it in every language.
  'whatsapp.confirmRequest.signOff': 'תודה, לתת עוד',
  // spec §6.1, word for word.
  'whatsapp.thankYou.thanks': 'הזמנתכם נאספה! תודה רבה שלקחתם חלק בלתת עוד!',
  'whatsapp.thankYou.orderAgain': 'להזמנה חוזרת:',

  // The booking form and its thank-you screen (web: OrderFormPage, OrderFields, ThankYou). Plain
  // texts with no copy elsewhere; the Hebrew is what the form showed before English existed.
  // {min} is MIN_BOTTLES.
  'form.title': 'הזמנת איסוף בקבוקים',
  'form.intro': 'ממלאים את הפרטים, ויואל יבוא לאסוף את הבקבוקים.',
  'form.privacy': 'הפרטים משמשים רק לתיאום האיסוף',
  'form.submit': 'שליחת הזמנה',
  'form.sending': 'שולח...',
  'form.notEnoughBottles': 'כדי לשלוח צריך לפחות {min} בקבוקים',
  'form.honeypotLabel': 'אתר אינטרנט',
  // The button that switches the form to the other language; each language names the other one.
  'form.switchLanguage': 'English',
  'form.name': 'שם',
  'form.phone': 'טלפון נייד',
  'form.phoneExample': 'למשל',
  // Copy of phone.ts PHONE_ERROR (kept out of ORDER_FORM_ERRORS, so formErrorText leaves it alone).
  'form.phoneInvalid': 'מספר נייד לא תקין. למשל: 050-1234567',
  'form.sectionDetails': 'פרטים',
  'form.sectionAddress': 'כתובת',
  'form.sectionBottles': 'בקבוקים',
  'form.street': 'רחוב',
  'form.houseNumber': 'מספר בית',
  'form.bottlesSpot': 'איפה הבקבוקים',
  'form.floorApt': 'קומה ודירה',
  'form.floorAptHint': "למשל: כניסה ב', קומה 3, דירה 12",
  'form.note': 'הערה (לא חובה)',
  'form.noteHint': 'למשל: ליד השער, קוד לבניין',
  'form.bottles': 'כמות בקבוקים',
  'form.bottlesHint': 'לפחות {min} בקבוקים',
  'form.unknownField': 'יש פרט שלא מולא נכון. נא לבדוק את הטופס ולנסות שוב.',
  'form.networkError': 'לא הצלחנו לשלוח. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',

  // The street picker.
  'street.freeTextLabel': 'שם הרחוב',
  'street.freeTextButton': 'הרחוב שלי לא ברשימה',
  'street.backToList': 'חזרה לרשימת הרחובות',
  'street.resultsLabel': 'רחובות שמתאימים לחיפוש',
  'street.chosen': 'נבחר: {name}',
  'street.notFound': 'לא מצאנו רחוב בשם הזה. אפשר לכתוב את השם אחרת.',
  'street.notFoundOrFreeText':
    'לא מצאנו רחוב בשם הזה. אפשר לכתוב את השם אחרת, או ללחוץ על "{button}".',
  'street.foundOne': 'נמצא רחוב אחד. נא ללחוץ עליו.',
  'street.foundMany': 'נמצאו {count} רחובות. נא ללחוץ על הרחוב הנכון.',
  'street.foundTooMany': 'נמצאו הרבה רחובות. נא להמשיך לכתוב את השם, או ללחוץ על הרחוב הנכון.',

  // The thank-you screen.
  'thankYou.title': 'תודה!',
  'thankYou.body': 'קיבלנו את ההזמנה. לפני הסבב באזור שלך נשלח לך הודעת WhatsApp לאישור.',
  'thankYou.viewOrder': 'לצפייה בהזמנה או לביטול',

  // The customer's own page (web: OrderPage). {date} is the round's day, {from}/{by} the times.
  // The Hebrew is what the page showed before English existed.
  'orderPage.heading': 'ההזמנה שלך',
  'orderPage.loading': 'טוען...',
  'orderPage.loadFailed': 'לא הצלחנו לטעון את ההזמנה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
  'orderPage.retry': 'לנסות שוב',
  'orderPage.toForm': 'לטופס ההזמנה',
  'orderPage.status': 'מצב ההזמנה:',
  'orderPage.waiting': 'נשלח לך הודעת WhatsApp לפני הסבב באזור שלך.',
  'orderPage.pendingDate': 'נעבור לאסוף ב-{date}.',
  'orderPage.confirmedDate': 'נתראה ב-{date}.',
  'orderPage.pickupWindow': 'נא להוציא את הבקבוקים בין השעות {from} ל-{by}.',
  'orderPage.pickupBy': 'נא להוציא את הבקבוקים עד השעה {by}.',
  'orderPage.collected': 'ההזמנה נאספה. תודה רבה שלקחתם חלק בלתת עוד!',
  'orderPage.cancelled': 'תודה! אפשר להזמין איסוף חדש בכל עת.',
  'orderPage.saved.confirm': 'תודה! האיסוף אושר.',
  'orderPage.saved.decline': 'קיבלנו. נחזור אליך עם מועד חדש.',
  'orderPage.saved.cancel': 'ההזמנה בוטלה.',
  'orderPage.saved.change': 'השינויים נשמרו.',
  'orderPage.leftRound': 'הכתובת עודכנה. ההזמנה יצאה מהסבב, ונחזור אליך עם מועד חדש.',
  'orderPage.phoneNotChanged': 'את מספר הטלפון אי אפשר לשנות כאן.',
  'orderPage.confirm': 'כן, אוציא את הבקבוקים',
  'orderPage.confirmDate': 'כן, אוציא את הבקבוקים ב-{date}',
  'orderPage.decline': 'לא מתאים הפעם',
  'orderPage.declineQuestion': 'לא מתאים לך הפעם? ההזמנה תחכה לסבב הבא.',
  'orderPage.declineConfirm': 'כן, לא מתאים',
  'orderPage.sending': 'שולח...',
  'orderPage.cancelOrder': 'ביטול ההזמנה',
  'orderPage.cancelQuestion': 'לבטל את ההזמנה?',
  'orderPage.cancelYes': 'כן, לבטל',
  'orderPage.cancelling': 'מבטל...',
  'orderPage.keep': 'לא, להשאיר',
  'orderPage.newOrder': 'הזמנה חדשה עם אותם פרטים',
  'orderPage.change': 'שינוי',
  'orderPage.changeHeading': 'שינוי פרטי ההזמנה',
  'orderPage.saveChange': 'שמירת השינויים',
  'orderPage.saving': 'שומר...',
  'orderPage.keepAsIs': 'בלי לשנות',
  'orderPage.saveFailed': 'לא הצלחנו לשמור. נא לבדוק את החיבור לאינטרנט ולנסות שוב.',
  'orderPage.leavesRound': 'שינוי הכתובת יוציא את ההזמנה מהסבב, ונחזור אליך עם מועד חדש.',
  'orderPage.leavesRoundDate':
    'שינוי הכתובת יוציא את ההזמנה מהסבב ב-{date}, ונחזור אליך עם מועד חדש.',
  'orderPage.details': 'פרטי ההזמנה',
  'orderPage.detailName': 'שם',
  'orderPage.detailPhone': 'טלפון',
  'orderPage.detailAddress': 'כתובת',
  'orderPage.detailSpot': 'איפה הבקבוקים',
  'orderPage.detailNote': 'הערה',
  'orderPage.detailBottles': 'כמות בקבוקים',
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

  // WhatsApp messages. The brand name "לתת עוד" stays in Hebrew: it is the name the customer
  // knows the project by, in either language.
  'whatsapp.greeting': 'Hello {name},',
  'whatsapp.confirmRequest.date': 'On {date} we will come to collect your bottles.',
  'whatsapp.confirmRequest.pickupWindow': 'Please put the bottles out between {from} and {by}.',
  'whatsapp.confirmRequest.pickupBy': 'Please put the bottles out by {by}.',
  'whatsapp.confirmRequest.confirmAtLink': 'Please confirm the pickup at this link:',
  'whatsapp.confirmRequest.signOff': 'Thank you, לתת עוד',
  'whatsapp.thankYou.thanks':
    'Your order has been collected! Thank you for taking part in לתת עוד!',
  'whatsapp.thankYou.orderAgain': 'To order again:',

  // The booking form and its thank-you screen.
  'form.title': 'Book a bottle pickup',
  'form.intro': 'Fill in your details and Yoel will come to collect the bottles.',
  'form.privacy': 'Your details are used only to arrange the pickup',
  'form.submit': 'Send order',
  'form.sending': 'Sending...',
  'form.notEnoughBottles': 'To send, at least {min} bottles are needed',
  'form.honeypotLabel': 'Website',
  'form.switchLanguage': 'עברית',
  'form.name': 'Name',
  'form.phone': 'Mobile phone',
  'form.phoneExample': 'For example',
  'form.phoneInvalid': 'Invalid mobile number. For example: 050-1234567',
  'form.sectionDetails': 'Details',
  'form.sectionAddress': 'Address',
  'form.sectionBottles': 'Bottles',
  'form.street': 'Street',
  'form.houseNumber': 'House number',
  'form.bottlesSpot': 'Where are the bottles',
  'form.floorApt': 'Floor and apartment',
  'form.floorAptHint': 'For example: entrance B, floor 3, apartment 12',
  'form.note': 'Note (optional)',
  'form.noteHint': 'For example: next to the gate, building code',
  'form.bottles': 'Number of bottles',
  'form.bottlesHint': 'At least {min} bottles',
  'form.unknownField': 'Something is not filled in correctly. Please check the form and try again.',
  'form.networkError': 'We could not send. Please check your internet connection and try again.',

  // The street picker.
  'street.freeTextLabel': 'Street name',
  'street.freeTextButton': 'My street is not on the list',
  'street.backToList': 'Back to the list of streets',
  'street.resultsLabel': 'Streets that match the search',
  'street.chosen': 'Chosen: {name}',
  'street.notFound': 'We did not find a street with this name. You can type the name differently.',
  'street.notFoundOrFreeText':
    'We did not find a street with this name. You can type the name differently, or tap "{button}".',
  'street.foundOne': 'One street found. Please tap it.',
  'street.foundMany': '{count} streets found. Please tap the right street.',
  'street.foundTooMany':
    'Many streets found. Please keep typing the name, or tap the right street.',

  // The thank-you screen.
  'thankYou.title': 'Thank you!',
  'thankYou.body':
    'We received your order. Before the round in your area we will send you a WhatsApp message to confirm.',
  'thankYou.viewOrder': 'View or cancel the order',

  // The customer's own page.
  'orderPage.heading': 'Your order',
  'orderPage.loading': 'Loading...',
  'orderPage.loadFailed':
    'We could not load the order. Please check your internet connection and try again.',
  'orderPage.retry': 'Try again',
  'orderPage.toForm': 'To the order form',
  'orderPage.status': 'Order status:',
  'orderPage.waiting': 'We will send you a WhatsApp message before the round in your area.',
  'orderPage.pendingDate': 'We will come to collect on {date}.',
  'orderPage.confirmedDate': 'See you on {date}.',
  'orderPage.pickupWindow': 'Please put the bottles out between {from} and {by}.',
  'orderPage.pickupBy': 'Please put the bottles out by {by}.',
  'orderPage.collected': 'The order was collected. Thank you for taking part in לתת עוד!',
  'orderPage.cancelled': 'Thank you! You can book a new pickup at any time.',
  'orderPage.saved.confirm': 'Thank you! The pickup is confirmed.',
  'orderPage.saved.decline': 'Got it. We will get back to you with a new date.',
  'orderPage.saved.cancel': 'The order was cancelled.',
  'orderPage.saved.change': 'The changes were saved.',
  'orderPage.leftRound':
    'The address was updated. The order left the round, and we will get back to you with a new date.',
  'orderPage.phoneNotChanged': 'The phone number cannot be changed here.',
  'orderPage.confirm': 'Yes, I will put the bottles out',
  'orderPage.confirmDate': 'Yes, I will put the bottles out on {date}',
  'orderPage.decline': 'Not this time',
  'orderPage.declineQuestion': 'Not suitable this time? The order will wait for the next round.',
  'orderPage.declineConfirm': 'Yes, not suitable',
  'orderPage.sending': 'Sending...',
  'orderPage.cancelOrder': 'Cancel the order',
  'orderPage.cancelQuestion': 'Cancel the order?',
  'orderPage.cancelYes': 'Yes, cancel',
  'orderPage.cancelling': 'Cancelling...',
  'orderPage.keep': 'No, keep it',
  'orderPage.newOrder': 'New order with the same details',
  'orderPage.change': 'Change',
  'orderPage.changeHeading': 'Change the order details',
  'orderPage.saveChange': 'Save changes',
  'orderPage.saving': 'Saving...',
  'orderPage.keepAsIs': 'Keep as is',
  'orderPage.saveFailed': 'We could not save. Please check your internet connection and try again.',
  'orderPage.leavesRound':
    'Changing the address will take the order out of the round, and we will get back to you with a new date.',
  'orderPage.leavesRoundDate':
    'Changing the address will take the order out of the round on {date}, and we will get back to you with a new date.',
  'orderPage.details': 'Order details',
  'orderPage.detailName': 'Name',
  'orderPage.detailPhone': 'Phone',
  'orderPage.detailAddress': 'Address',
  'orderPage.detailSpot': 'Where are the bottles',
  'orderPage.detailNote': 'Note',
  'orderPage.detailBottles': 'Number of bottles',
} as const satisfies Record<MessageKey, string>;

/** The app's dictionary: every UI text in every {@link Lang}. Read it through {@link t}. */
export const MESSAGES: Dictionary<MessageKey> = { he: HE, en: EN };

/** The app text of `key` in `lang`, placeholders filled from `vars` (see {@link translate}). */
export function t(lang: Lang, key: MessageKey, vars?: TranslationVars): string {
  return translate(MESSAGES, lang, key, vars);
}
