// The WhatsApp messages (ADR-0003, spec §6.1): their text, the message the api hands its
// MessageSender, the "שלח" row the collector app shows for each wa.me link, and the contract of the
// route that marks a link as opened. One source for the text, whether it goes into a wa.me link
// now or a Cloud API template later. The lines' wording lives in the i18n dictionary
// (`whatsapp.*`), in Hebrew and English; the message goes out in the customer's language.
import { z } from 'zod';
import type { OrderNotFoundErrorBody } from './collectorOrdersApi.ts';
import { formatDayMonth, formatPickupTime, formatWeekday, pickupTimeSchema } from './dates.ts';
import { DEFAULT_LANG, t, type Lang } from './i18n.ts';
import {
  messageKindSchema,
  messageLogEntrySchema,
  orderSchema,
  timestampSchema,
  type MessageKind,
  type Order,
} from './order.ts';

// ---------------------------------------------------------------------------------------------
// The outgoing message
// ---------------------------------------------------------------------------------------------

/** The values a message is filled with ({@link renderMessage}). */
export interface MessageVars {
  /** The customer's name as stored; trimmed when rendered. */
  name: string;
  /** Absolute URL of the customer's page `/o/<token>`: to decline, change or cancel, or to order again. */
  link: string;
  /** The round's calendar day in Israel, `YYYY-MM-DD`. Required by `confirmRequest`. */
  date?: string;
  /**
   * End of the window Yoel comes in, `HH:MM` ({@link pickupTimeSchema}); alone, the time to put the
   * bottles out by. `confirmRequest` only.
   */
  pickupBy?: string;
  /**
   * Start of the window Yoel comes in, `HH:MM`, which is also the time the bottles must be out by
   * (ADR-0012); needs `pickupBy` (the end). `confirmRequest` only.
   */
  pickupFrom?: string;
}

/**
 * What the api's `MessageSender.send` gets (ADR-0003's shape, plus `vars.pickupBy`). The sender
 * turns it into a wa.me link today, or a Cloud API template if Yoel ever goes automatic.
 */
export interface OutgoingMessage {
  kind: MessageKind;
  orderId: string;
  /** The customer's phone in E.164, e.g. `+972501234567` (`order.contact.phone`). */
  to: string;
  vars: MessageVars;
  /** Yoel's own words for this round. `confirmRequest` only; `thankYou` ignores it. */
  personalText?: string;
  /**
   * The language to write the message in: the customer's language (`order.lang`). Missing means
   * Hebrew ({@link DEFAULT_LANG}), as for every message sent before languages existed.
   */
  lang?: Lang;
}

// ---------------------------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------------------------

/** The greeting that opens every message: "שלום <name>," / "Hello <name>,". */
function greetingLine(vars: MessageVars, lang: Lang): string {
  return t(lang, 'whatsapp.greeting', { name: vars.name.trim() });
}

/**
 * The round message (kind `confirmRequest`, a name kept from before ADR-0012, since it is stored in
 * every order's message log): sent when Yoel plans a round, announcing the pickup. It asks for no
 * confirmation; the link is for "לא מתאים הפעם", a change or a cancel. The
 * sign-off (`whatsapp.confirmRequest.signOff`) ends with the app's name, `APP_NAME` in index.ts;
 * a test checks that in every language (index.ts re-exports this file, so it cannot be imported).
 */
function confirmRequestLines(
  vars: MessageVars,
  personalText: string | undefined,
  lang: Lang,
): string[] {
  if (vars.date === undefined) {
    throw new RangeError('renderMessage: confirmRequest needs a date');
  }
  // Checked before it goes into the text; the message says what is wrong, never the value itself.
  if (vars.pickupBy !== undefined && !pickupTimeSchema.safeParse(vars.pickupBy).success) {
    throw new RangeError('renderMessage: expected pickupBy as HH:MM');
  }
  if (vars.pickupFrom !== undefined) {
    if (!pickupTimeSchema.safeParse(vars.pickupFrom).success) {
      throw new RangeError('renderMessage: expected pickupFrom as HH:MM');
    }
    // A window needs both ends; a lone start would read as half a sentence.
    if (vars.pickupBy === undefined) {
      throw new RangeError('renderMessage: pickupFrom needs pickupBy');
    }
  }
  const lines = [
    greetingLine(vars, lang),
    // Throws a RangeError, without the value, for a date that is not YYYY-MM-DD. "05/11" and
    // "יום רביעי" in Hebrew, "Nov 5" and "Wednesday" in English.
    t(lang, 'whatsapp.confirmRequest.date', {
      date: formatDayMonth(vars.date, lang),
      weekday: formatWeekday(vars.date, lang),
    }),
  ];
  // Both times were validated above. Hebrew keeps the 24-hour "08:00"; English reads "8:00 AM".
  // With both, two lines: "out by {from}" and "we come between {from} and {by}" — the window is
  // when Yoel comes, so the bottles must already be out when it starts (ADR-0012).
  if (vars.pickupBy !== undefined && vars.pickupFrom !== undefined) {
    const from = formatPickupTime(vars.pickupFrom, lang);
    lines.push(
      t(lang, 'whatsapp.confirmRequest.putOutBy', { from }),
      t(lang, 'whatsapp.confirmRequest.arrivalWindow', {
        from,
        by: formatPickupTime(vars.pickupBy, lang),
      }),
    );
  } else if (vars.pickupBy !== undefined) {
    lines.push(
      t(lang, 'whatsapp.confirmRequest.pickupBy', { by: formatPickupTime(vars.pickupBy, lang) }),
    );
  }
  // Yoel's own words go in as he wrote them, never translated. A personal text that is only
  // spaces is as good as none: no blank line in the message.
  const personal = personalText?.trim() ?? '';
  if (personal !== '') lines.push(personal);
  lines.push(
    t(lang, 'whatsapp.confirmRequest.changeAtLink'),
    vars.link,
    t(lang, 'whatsapp.confirmRequest.signOff'),
  );
  return lines;
}

/** "תודה": sent on "אספתי", with the customer's page for ordering again (spec §6.1). */
function thankYouLines(vars: MessageVars, lang: Lang): string[] {
  return [
    greetingLine(vars, lang),
    t(lang, 'whatsapp.thankYou.thanks'),
    t(lang, 'whatsapp.thankYou.orderAgain'),
    vars.link,
  ];
}

/**
 * The text of a WhatsApp message, lines joined with '\n' (ADR-0003). The wa.me sender encodes it
 * into its link; a Cloud API sender would map `kind` to a template instead.
 *
 * - `confirmRequest`: name, the round's date, the pickup time if given, Yoel's personal text if
 *   it is not blank (trimmed, its own line breaks kept, never translated), the link for "not this
 *   time" or a cancel, sign-off. It asks for no confirmation (ADR-0012).
 * - `thankYou`: name, the thanks of spec §6.1, the link for ordering again. It ignores `date`,
 *   `pickupBy` and `personalText`: the personal text belongs to the round message only.
 *
 * `lang` is the customer's language (`order.lang`), Hebrew by default. Hebrew writes the date as
 * DD/MM ("05/11") and times on a 24-hour clock ("08:00"); English writes "Nov 5" and "8:00 AM".
 * The brand name "לתת עוד" stays in Hebrew in both.
 *
 * @throws RangeError when `confirmRequest` has no `date`, a `date` that is not a real
 *   `YYYY-MM-DD`, a `pickupBy` or `pickupFrom` that is not `HH:MM`, or a `pickupFrom` without
 *   `pickupBy`; the same in every language. The message never contains the value: it may reach
 *   the logs.
 */
export function renderMessage(
  kind: MessageKind,
  vars: MessageVars,
  personalText?: string,
  lang: Lang = DEFAULT_LANG,
): string {
  const lines =
    kind === 'confirmRequest'
      ? confirmRequestLines(vars, personalText, lang)
      : thankYouLines(vars, lang);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The "שלח" list
// ---------------------------------------------------------------------------------------------

// The `manual` option of the message log (a wa.me link). By position, but checked: `.shape.url`
// would not type-check on the `sent` or `failed` option.
const manualLogEntrySchema = messageLogEntrySchema.options[1];

/**
 * One row of the collector app's "שלח" list (ADR-0003): a customer, and the wa.me link Yoel taps to
 * open WhatsApp with the message written. Built from the order's message log by
 * {@link toMessageLink}; the round api returns these rows. The fields reuse the stored order's
 * schemas, so the ISO `openedAt` of the api's JSON parses back into a `Date` on the web.
 */
export const messageLinkSchema = z.object({
  orderId: orderSchema.shape.id,
  /** Position of the entry in `order.messages`: the `:index` of the "opened" route. */
  messageIndex: z.int().nonnegative(),
  kind: messageKindSchema,
  /** The customer's name, so Yoel sees whom the row sends to. */
  name: orderSchema.shape.contact.shape.name,
  /** https only, like the stored entry: the app puts it in a link, never a `javascript:` url. */
  url: manualLogEntrySchema.shape.url,
  /** When Yoel opened the link; set means the row shows as already opened. */
  openedAt: manualLogEntrySchema.shape.openedAt,
});
export type MessageLink = z.infer<typeof messageLinkSchema>;

/**
 * The "שלח" row of an order for one kind of message, from the NEWEST entry of that kind in its
 * log: a row when that entry is a `manual` (wa.me) link, `undefined` otherwise (no message of the
 * kind yet, or the newest one was `sent` automatically or `failed`). Entries of the other kind are
 * ignored. Pure.
 *
 * Only the newest entry counts, never an older `manual` one behind it: an order planned into a
 * second round must not get the first round's link, with its old date. If the newest request
 * failed, there is no row to send rather than a stale one.
 */
export function toMessageLink(order: Order, kind: MessageKind): MessageLink | undefined {
  const index = order.messages.findLastIndex((entry) => entry.kind === kind);
  const entry = order.messages[index];
  if (entry?.mode !== 'manual') return undefined;
  return {
    orderId: order.id,
    messageIndex: index,
    kind,
    name: order.contact.name,
    url: entry.url,
    // Left out rather than set to undefined when the link was never opened.
    ...(entry.openedAt === undefined ? {} : { openedAt: entry.openedAt }),
  };
}

// ---------------------------------------------------------------------------------------------
// POST /api/collector/orders/:id/messages/:index/opened
// ---------------------------------------------------------------------------------------------

/**
 * Body of a 200 from POST /api/collector/orders/:id/messages/:index/opened, which Yoel's "שלח"
 * button calls as it opens the wa.me link (behind requireCollector, ADR-0004). The route sets the
 * entry's `openedAt` and never changes the order's status: nobody can know whether Yoel then
 * really tapped "send" in WhatsApp (ADR-0003). An entry already opened answers 200 with its FIRST
 * `openedAt` and writes nothing, so tapping twice is harmless.
 */
export const messageOpenedResponseSchema = z.object({
  openedAt: timestampSchema,
});
export type MessageOpenedResponse = z.infer<typeof messageOpenedResponseSchema>;

// The body below follows ApiErrorBody (index.ts): a stable `error` code. Standalone, like
// collectorOrdersApi.ts, because index.ts re-exports this file.

/**
 * 404 from the "opened" route: `:index` is not a whole number, is past the end of the order's
 * message log, or the entry there is not a `manual` link. An unknown order id answers
 * {@link OrderNotFoundErrorBody} instead, like every /api/collector/orders/:id route.
 */
export interface MessageNotFoundErrorBody {
  error: 'message_not_found';
}

/** Every error body the "opened" route adds to ApiErrorBody's; a 401 comes from the login guard. */
export type MessageOpenedErrorBody = OrderNotFoundErrorBody | MessageNotFoundErrorBody;
