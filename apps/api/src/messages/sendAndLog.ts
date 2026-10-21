// Sending one WhatsApp message for one order, and keeping a record of it (ADR-0003): build the
// message from the order (orderMessage), hand it to the MessageSender, and append what the sender
// answered to the order's `messages` log (sendAndLog). Round planning (section 8, "בקשת אישור")
// and "אספתי" ("תודה") call these; the collector app then shows each `manual` entry as a "שלח"
// button (toMessageLink in packages/shared).
import {
  messageLogEntrySchema,
  type MessageKind,
  type MessageLogEntry,
  type MessageVars,
  type Order,
  type OutgoingMessage,
} from '@bottlerun/shared';
import { logError } from '../errors.ts';
import type { OrdersRepo } from '../orders/ordersRepo.ts';
import type { MessageSender, SendResult } from './messageSender.ts';

/**
 * The absolute URL of the customer's page (spec §3.3): `${publicBaseUrl}/o/<token>`. The page is
 * reached only by the order's random token, never by its id. A stored token is base64url and
 * needs no escaping; it is encoded anyway, so a malformed one can never change the path.
 *
 * @param publicBaseUrl The site's origin without a trailing slash (`MessagingDeps.publicBaseUrl`).
 */
export function orderPageUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/o/${encodeURIComponent(token)}`;
}

/** What {@link orderMessage} needs besides the order and the kind of message. */
export interface OrderMessageOptions {
  /** The site's origin, without a trailing slash (`MessagingDeps.publicBaseUrl`). */
  publicBaseUrl: string;
  /** The round's calendar day in Israel, `YYYY-MM-DD`. A `confirmRequest` cannot do without it. */
  date?: string;
  /** Time to put the bottles out by, `HH:MM` (ADR-0003). Only the confirmation request says it. */
  pickupBy?: string;
  /** Start of the pickup window, `HH:MM`. Only valid together with `pickupBy` (the window end). */
  pickupFrom?: string;
  /** Yoel's own words for the round. Kept for `confirmRequest` only (see below). */
  personalText?: string;
}

/**
 * The {@link OutgoingMessage} of `kind` for `order`: to the customer's stored phone (E.164),
 * greeting them by name, with the link to their page (to confirm the round, or to order again).
 *
 * Only the optional values that are given are set, never as `undefined`. `personalText` is set
 * for `confirmRequest` only: the thanks are the same for everyone (spec §6.1). Nothing is checked
 * here; the sender renders the text and rejects a `confirmRequest` without a valid `date`.
 */
export function orderMessage(
  order: Order,
  kind: MessageKind,
  options: OrderMessageOptions,
): OutgoingMessage {
  const vars: MessageVars = {
    name: order.contact.name,
    link: orderPageUrl(options.publicBaseUrl, order.token),
  };
  if (options.date !== undefined) vars.date = options.date;
  if (options.pickupBy !== undefined) vars.pickupBy = options.pickupBy;
  if (options.pickupFrom !== undefined) vars.pickupFrom = options.pickupFrom;

  const message: OutgoingMessage = { kind, orderId: order.id, to: order.contact.phone, vars };
  if (kind === 'confirmRequest' && options.personalText !== undefined) {
    message.personalText = options.personalText;
  }
  return message;
}

/** What {@link sendAndLog} talks to. */
export interface SendAndLogDeps {
  /** Where the order's message log is written. */
  orders: OrdersRepo;
  /** Sends or prepares the message (`MessagingDeps.sender`). */
  sender: MessageSender;
  /** Clock for the log entry's `at` and the order's `updatedAt`; defaults to the real clock. */
  now?: () => Date;
}

/** What {@link sendAndLog} did. */
export interface SendAndLogResult {
  /** The order as stored after the entry was appended: pass it to the next call for this order. */
  order: Order;
  /**
   * What became of the message, as it was logged. A sender that rejected shows here as
   * `failed` / `sender_error`, and a result the log does not accept as `failed` / `invalid_result`.
   */
  result: SendResult;
  /** Position of the new entry in `order.messages`: the `:index` of the "opened" route. */
  messageIndex: number;
}

/**
 * Sends `message` with `deps.sender` and appends the outcome to `order`'s message log
 * (ADR-0003). It never changes the order's status: logging a message is not a status change
 * (a `manual` link may never be sent at all; the customer's confirmation is what moves the order).
 *
 * The outcome is always logged, and a failure never throws, so a caller going through a round's
 * orders keeps going when the third one fails:
 * - The sender's result is stored as it is (`manual` + url, `sent` + providerId, `failed` +
 *   reason), after a check against the shared `messageLogEntrySchema`. A result the log does not
 *   accept (say, a `manual` url that is not https, which the collector app would put in a link)
 *   is stored as `failed` / `invalid_result` instead.
 * - A sender that rejects (a bug, a message that cannot be rendered) is logged with
 *   {@link logError}, without the message, and stored as `failed` / `sender_error`.
 *
 * Known limit: this is a read-modify-write of the whole `messages` array, built on the `order` the
 * caller passes, so pass the order as just read or just returned by the previous call. Two writes
 * to one order's log at the same moment would lose one entry; with one collector tapping one
 * button at a time that does not happen. If it ever can, the fix is an atomic `$push` in
 * OrdersRepo.
 *
 * @throws Error when `message` belongs to another order (a bug in the caller; nothing is sent),
 *   or when the order no longer exists by the time the entry is written. Errors of the repo
 *   itself are not caught. The messages hold no customer data.
 */
export async function sendAndLog(
  deps: SendAndLogDeps,
  order: Order,
  message: OutgoingMessage,
): Promise<SendAndLogResult> {
  if (message.orderId !== order.id) {
    throw new Error('sendAndLog: the message belongs to another order');
  }

  let sent: SendResult;
  try {
    sent = await deps.sender.send(message);
  } catch (error) {
    // logError writes no request and, for most errors, no message: only fields free of data.
    logError(error);
    sent = { mode: 'failed', reason: 'sender_error' };
  }

  const at = deps.now?.() ?? new Date();
  const checked = logEntryFor(message.kind, at, sent);
  const entry: MessageLogEntry = checked ?? {
    kind: message.kind,
    at,
    mode: 'failed',
    reason: 'invalid_result',
  };
  const result: SendResult =
    checked === undefined ? { mode: 'failed', reason: 'invalid_result' } : sent;

  const messageIndex = order.messages.length;
  // `messages` and `updatedAt` only: never the status, and no `ifStatus`, because a message is
  // logged whatever the status (a thank-you goes to a `collected` order).
  const updated = await deps.orders.update(order.id, {
    messages: [...order.messages, entry],
    updatedAt: new Date(at),
  });
  if (updated === null) {
    throw new Error('sendAndLog: the order no longer exists');
  }
  return { order: updated, result, messageIndex };
}

/**
 * The log entry for the sender's `result`, with exactly the fields of its mode, or undefined
 * when the shared schema does not accept it (an http or `javascript:` url, an empty provider id,
 * a mode the log does not know). The sender is typed, but its answer is still checked: whatever
 * is stored here is later put in a link on Yoel's screen.
 */
function logEntryFor(kind: MessageKind, at: Date, result: SendResult): MessageLogEntry | undefined {
  let candidate: unknown;
  switch (result.mode) {
    case 'manual':
      candidate = { kind, at, mode: 'manual', url: result.url };
      break;
    case 'sent':
      candidate = { kind, at, mode: 'sent', providerId: result.providerId };
      break;
    case 'failed':
      candidate = { kind, at, mode: 'failed', reason: result.reason };
      break;
  }
  const parsed = messageLogEntrySchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
