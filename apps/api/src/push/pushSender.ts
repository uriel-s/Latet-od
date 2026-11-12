// The api's door to browser Web Push services (ADR-0013): when a new order arrives from the public
// form, the api sends a PushNotificationPayload to each stored collector subscription through a
// PushSender. Production uses WebPushSender when VAPID env vars are set; when they are not, there
// is no sender at all (`AppDeps.push` is null). Tests use FakePushSender (fakePushSender.ts).
import type { PushNotificationPayload, PushSubscription } from '@bottlerun/shared';

/**
 * What became of sending one Web Push notification to one subscription (ADR-0013):
 *
 * - `sent`: the browser push service accepted the notification (HTTP 2xx).
 * - `gone`: the push service answered 404 or 410 — the subscription expired or was unsubscribed on
 *   the device, so the caller should delete it from `pushSubscriptions`.
 * - `failed`: any other failure (5xx, 4xx other than 404/410, network error, invalid subscription
 *   keys). `reason` is a short code with no customer or subscription data.
 */
export type PushSendResult =
  { status: 'sent' } | { status: 'gone' } | { status: 'failed'; reason: string };

/**
 * Sends one Web Push notification to one device subscription (ADR-0013). Implementations:
 * `WebPushSender` (production, only when VAPID is configured) and `FakePushSender` (tests).
 *
 * Expected delivery failures resolve `{ status: 'gone' }` or `{ status: 'failed' }` instead of
 * rejecting, so best-effort notification fan-out never fails order creation.
 */
export interface PushSender {
  send(subscription: PushSubscription, payload: PushNotificationPayload): Promise<PushSendResult>;
}
