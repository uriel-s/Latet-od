// The WhatsApp messages (ADR-0003, spec §6.1): their text, the message the api hands its
// MessageSender, the "שלח" row the collector app shows for each wa.me link, and the contract of the
// route that marks a link as opened. One source for the text, whether it goes into a wa.me link
// now or a Cloud API template later.
import { z } from 'zod';
import type { OrderNotFoundErrorBody } from './collectorOrdersApi.ts';
import { formatDayMonth } from './dates.ts';
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

/**
 * "עד איזו שעה להוציא את הבקבוקים" (ADR-0003): an optional time of the round, `HH:MM` on a 24-hour
 * clock, two digits each (00:00-23:59). Strict, so the message never says "עד השעה 8:0".
 */
export const pickupTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected a time HH:MM, 00:00-23:59');

/** The values a message is filled with ({@link renderMessage}). */
export interface MessageVars {
  /** The customer's name as stored; trimmed when rendered. */
  name: string;
  /** Absolute URL of the customer's page `/o/<token>`: to confirm, or to order again. */
  link: string;
  /** The round's calendar day in Israel, `YYYY-MM-DD`. Required by `confirmRequest`. */
  date?: string;
  /** Time to put the bottles out by, `HH:MM` ({@link pickupTimeSchema}). `confirmRequest` only. */
  pickupBy?: string;
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
}

// ---------------------------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------------------------

/**
 * Sign-off of the confirmation request: the app's name, `APP_NAME` in index.ts. Written out here
 * because index.ts re-exports this file, so importing from it would be circular. A test checks
 * that the two still agree.
 */
const CONFIRM_REQUEST_SIGN_OFF = 'תודה, לתת עוד';

/** "בקשת אישור": sent when Yoel plans a round, asking the customer to confirm the pickup. */
function confirmRequestLines(vars: MessageVars, personalText: string | undefined): string[] {
  if (vars.date === undefined) {
    throw new RangeError('renderMessage: confirmRequest needs a date');
  }
  // Checked before it goes into the text; the message says what is wrong, never the value itself.
  if (vars.pickupBy !== undefined && !pickupTimeSchema.safeParse(vars.pickupBy).success) {
    throw new RangeError('renderMessage: expected pickupBy as HH:MM');
  }
  const lines = [
    `שלום ${vars.name.trim()},`,
    // Throws a RangeError, without the value, for a date that is not YYYY-MM-DD.
    `ב-${formatDayMonth(vars.date)} נעבור לאסוף את הבקבוקים שלכם.`,
  ];
  if (vars.pickupBy !== undefined) {
    lines.push(`נא להוציא את הבקבוקים עד השעה ${vars.pickupBy}.`);
  }
  // A personal text that is only spaces is as good as none: no blank line in the message.
  const personal = personalText?.trim() ?? '';
  if (personal !== '') lines.push(personal);
  lines.push('נא לאשר את האיסוף בקישור:', vars.link, CONFIRM_REQUEST_SIGN_OFF);
  return lines;
}

/** "תודה": sent on "אספתי", with the customer's page for ordering again (spec §6.1). */
function thankYouLines(vars: MessageVars): string[] {
  return [
    `שלום ${vars.name.trim()},`,
    // spec §6.1, word for word.
    'הזמנתכם נאספה! תודה רבה שלקחתם חלק בלתת עוד!',
    'להזמנה חוזרת:',
    vars.link,
  ];
}

/**
 * The text of a WhatsApp message, lines joined with '\n' (ADR-0003). The wa.me sender encodes it
 * into its link; a Cloud API sender would map `kind` to a template instead.
 *
 * - `confirmRequest`: name, the round's date as DD/MM, the pickup time if given, Yoel's personal
 *   text if it is not blank (trimmed, its own line breaks kept), the link to confirm, sign-off.
 * - `thankYou`: name, the thanks of spec §6.1, the link for ordering again. It ignores `date`,
 *   `pickupBy` and `personalText`: the personal text belongs to the confirmation request only.
 *
 * @throws RangeError when `confirmRequest` has no `date`, a `date` that is not a real
 *   `YYYY-MM-DD`, or a `pickupBy` that is not `HH:MM`. The message never contains the value: it
 *   may reach the logs.
 */
export function renderMessage(kind: MessageKind, vars: MessageVars, personalText?: string): string {
  const lines =
    kind === 'confirmRequest' ? confirmRequestLines(vars, personalText) : thankYouLines(vars);
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
