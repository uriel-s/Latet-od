// The api's door to WhatsApp (ADR-0003, "ממשק MessageSender"): round planning and "אספתי" hand a
// message to a MessageSender and store what it answers in the order's message log. The MVP
// implementation prepares a wa.me link (waMeLinkSender.ts); a CloudApiSender can replace it if
// Yoel ever goes automatic; tests use FakeSender (fakeSender.ts). The env picks one
// (MESSAGE_SENDER, messagingConfig.ts).
import type { OutgoingMessage } from '@bottlerun/shared';

/**
 * What became of one message (ADR-0003). It mirrors the order's message log entry
 * (`messageLogEntrySchema` in packages/shared), which stores these fields as they are:
 *
 * - `sent`: sent automatically (Cloud API); `providerId` is the provider's message id.
 * - `manual`: nothing was sent; the collector app shows a "שלח" button that opens `url` (a wa.me
 *   link) and Yoel taps "send" in WhatsApp himself. The log accepts only an https `url`.
 * - `failed`: not sent and no link. `reason` is a short code such as `invalid_phone`: it is stored
 *   in the order and may be logged, so it never contains customer data (no phone, name or text).
 */
export type SendResult =
  | { mode: 'sent'; providerId: string }
  | { mode: 'manual'; url: string }
  | { mode: 'failed'; reason: string };

/**
 * Sends (or prepares) one WhatsApp message (ADR-0003). Implementations: `WaMeLinkSender` (MVP),
 * `FakeSender` (tests), a `CloudApiSender` later.
 *
 * An expected failure (a phone the channel cannot reach, a provider that refuses the message)
 * resolves `{ mode: 'failed' }` instead of rejecting, so the caller can log it on the order like
 * any other result. A rejection means something unexpected (a bug, a message that cannot be
 * rendered), and the caller treats it as an error.
 */
export interface MessageSender {
  send(message: OutgoingMessage): Promise<SendResult>;
}
