// The contract of /api/collector/push/* and the Web Push notification payload (ADR-0013):
// subscribing and unsubscribing a collector browser device, reading whether VAPID is configured,
// and building the Hebrew notification sent when a new order arrives from the public form.
import { z } from 'zod';
import type { Order } from './order.ts';

// ---------------------------------------------------------------------------------------------
// Subscription & requests
// ---------------------------------------------------------------------------------------------

/** Longest push endpoint URL accepted by the api. Real browser endpoints are a few hundred chars. */
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

/** Longest base64/base64url key (`p256dh` or `auth`) accepted in a push subscription. */
export const PUSH_KEY_MAX_LENGTH = 256;

/**
 * A Web Push subscription as sent by `POST /api/collector/push/subscribe` and stored by the api
 * (ADR-0013). `endpoint` must be an `https:` URL (Web Push requires TLS, and the server sends an
 * HTTP POST to it); `keys` carries the browser's P-256 ECDH public key (`p256dh`) and 16-byte
 * authentication secret (`auth`). Unknown keys are rejected.
 */
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(PUSH_ENDPOINT_MAX_LENGTH),
  keys: z.strictObject({
    p256dh: z.string().trim().min(1).max(PUSH_KEY_MAX_LENGTH),
    auth: z.string().trim().min(1).max(PUSH_KEY_MAX_LENGTH),
  }),
});
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

/**
 * Body of `POST /api/collector/push/unsubscribe`: identifies the device subscription to remove by
 * its `endpoint`. Strict so malformed bodies are rejected with 400.
 */
export const unsubscribePushRequestSchema = z.strictObject({
  endpoint: pushSubscriptionSchema.shape.endpoint,
});
export type UnsubscribePushRequest = z.infer<typeof unsubscribePushRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Config response
// ---------------------------------------------------------------------------------------------

/**
 * Body of a 200 from `GET /api/collector/push/config` (ADR-0013). When VAPID keys are configured in
 * the api's env, `enabled` is `true` and `publicKey` is the base64url VAPID public key for
 * `pushManager.subscribe({ applicationServerKey })`. When VAPID env vars are unset, `enabled` is
 * `false` and the collector app hides or disables the push toggle.
 */
export const pushConfigResponseSchema = z.discriminatedUnion('enabled', [
  z.strictObject({
    enabled: z.literal(true),
    publicKey: z.string().trim().min(1),
  }),
  z.strictObject({
    enabled: z.literal(false),
  }),
]);
export type PushConfigResponse = z.infer<typeof pushConfigResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Notification payload
// ---------------------------------------------------------------------------------------------

/** Title of the Web Push notification sent to Yoel when a customer books an order (ADR-0013). */
export const NEW_ORDER_PUSH_TITLE = 'הזמנה חדשה — לתת עוד';

/** Relative URL the Service Worker opens or focuses when Yoel taps the notification (ADR-0013). */
export const NEW_ORDER_PUSH_URL = '/app/orders';

/**
 * JSON payload encrypted into a Web Push message by the api and read by `apps/web/public/sw.js` in
 * its `push` event handler (ADR-0013).
 */
export const pushNotificationPayloadSchema = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
  url: z.string().regex(/^\/[^/\\]/u, 'url must be a relative path starting with /'),
});
export type PushNotificationPayload = z.infer<typeof pushNotificationPayloadSchema>;

/**
 * Builds the Hebrew Web Push notification payload for a newly created customer order (ADR-0013).
 * Shows the customer's name, street and house number, and estimated bottle count, and opens the
 * collector orders screen (`/app/orders`) when tapped.
 */
export function buildNewOrderPushPayload(
  order: Pick<Order, 'contact' | 'address' | 'bottlesEstimated'>,
): PushNotificationPayload {
  return {
    title: NEW_ORDER_PUSH_TITLE,
    body: `${order.contact.name} · ${order.address.streetName} ${order.address.houseNumber} · כ־${order.bottlesEstimated} בקבוקים`,
    url: NEW_ORDER_PUSH_URL,
  };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

// The bodies below follow ApiErrorBody (index.ts): a stable `error` code. Standalone, like
// authApi.ts, because index.ts re-exports this file.

/**
 * 400 from `POST /api/collector/push/subscribe` or `POST /api/collector/push/unsubscribe`: the
 * request body did not match {@link pushSubscriptionSchema} or {@link unsubscribePushRequestSchema}.
 */
export interface InvalidPushSubscriptionErrorBody {
  error: 'invalid_push_subscription';
}

/**
 * 503 from `POST /api/collector/push/subscribe` when VAPID keys are not configured on the server.
 */
export interface PushNotConfiguredErrorBody {
  error: 'push_not_configured';
}

/**
 * Every error body `/api/collector/push/*` adds to the ones every route may answer (ApiErrorBody).
 * A 401 comes from `requireCollector`: authApi.ts's `UnauthenticatedErrorBody`.
 */
export type CollectorPushErrorBody = InvalidPushSubscriptionErrorBody | PushNotConfiguredErrorBody;
