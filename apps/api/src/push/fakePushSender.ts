// In-memory PushSender for tests (ADR-0013): records every (subscription, payload) call in order
// and answers with a result the test controls, so routes and notification fan-out never touch the
// network or require real VAPID keys.
import type { PushNotificationPayload, PushSubscription } from '@bottlerun/shared';
import type { PushSender, PushSendResult } from './pushSender.ts';

/**
 * Fixed, valid 65-byte uncompressed P-256 public key in base64url (the NIST P-256 generator point
 * G, 87 chars starting with `B`), used as the default `publicKey` in `createFakePush()`.
 */
export const FAKE_VAPID_PUBLIC_KEY =
  'BGsX0fLhLEJH-LzmlWOkQPJ3A32BLeszolShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';

/** One call recorded by {@link FakePushSender}. */
export interface FakePushSendCall {
  subscription: PushSubscription;
  payload: PushNotificationPayload;
}

/**
 * How a {@link FakePushSender} answers one call; may throw or reject to simulate an unexpected
 * sender error.
 */
export type FakePushRespond = (call: FakePushSendCall) => PushSendResult | Promise<PushSendResult>;

/**
 * A fake {@link PushSender}. Every call to `send` is cloned into {@link FakePushSender.sent}, then
 * answered by `respond` (default `{ status: 'sent' }`).
 */
export class FakePushSender implements PushSender {
  /**
   * Every `(subscription, payload)` pair given to `send`, in order: defensive copies
   * (`structuredClone`), recorded before `respond` runs so a call whose `respond` rejects is
   * still recorded.
   */
  readonly sent: FakePushSendCall[] = [];

  private readonly respond: FakePushRespond;

  /**
   * @param respond Custom response per call, e.g. `() => ({ status: 'gone' })` to test expired
   *   subscription cleanup. Defaults to `() => ({ status: 'sent' })`.
   */
  constructor(respond?: FakePushRespond) {
    this.respond = respond ?? (() => ({ status: 'sent' }));
  }

  send(subscription: PushSubscription, payload: PushNotificationPayload): Promise<PushSendResult> {
    const call: FakePushSendCall = structuredClone({ subscription, payload });
    this.sent.push(call);
    // A synchronous throw in `respond` rejects the returned promise instead of escaping `send`.
    return new Promise((resolve) => {
      resolve(this.respond(call));
    });
  }
}
