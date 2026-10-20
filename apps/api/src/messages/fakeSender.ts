// In-memory MessageSender for tests (ADR-0003): it records every message it is given and answers
// with a result the test controls, so round planning and "אספתי" can be tested without WhatsApp
// and without depending on the wa.me link format.
import type { OutgoingMessage } from '@bottlerun/shared';
import type { MessageSender, SendResult } from './messageSender.ts';

/** How a {@link FakeSender} answers one message; may throw or reject to simulate a broken sender. */
export type FakeRespond = (message: OutgoingMessage) => SendResult | Promise<SendResult>;

/**
 * A fake {@link MessageSender}. Every call to `send` is recorded in {@link FakeSender.sent}, then
 * answered by `respond`.
 *
 * The default answer is `{ mode: 'manual', url: 'https://fake-sender.test/<n>' }`, where n is the
 * message's 1-based position in `sent` (1, 2, …), so a test can tell which message a logged url
 * belongs to. https, because the order's message log accepts only an https url.
 */
export class FakeSender implements MessageSender {
  /**
   * Every message given to `send`, in order: copies (structuredClone), so a caller that changes
   * its object afterwards does not change what the test sees. Recorded before `respond` runs, so a
   * message whose `respond` rejects is here too.
   */
  readonly sent: OutgoingMessage[] = [];

  private readonly respond: FakeRespond;

  /**
   * @param respond The answer to each message, e.g. `() => ({ mode: 'failed', reason: 'x' })`.
   *   One that throws or rejects makes `send` reject with that error: a sender that blows up.
   */
  constructor(respond?: FakeRespond) {
    this.respond =
      respond ?? (() => ({ mode: 'manual', url: `https://fake-sender.test/${this.sent.length}` }));
  }

  send(message: OutgoingMessage): Promise<SendResult> {
    this.sent.push(structuredClone(message));
    // A synchronous throw in `respond` rejects the promise instead of escaping `send`; a returned
    // promise is adopted as it is.
    return new Promise((resolve) => {
      resolve(this.respond(message));
    });
  }
}
