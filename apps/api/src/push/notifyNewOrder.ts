// How the collector (Yoel) is notified when a new order arrives from the public form (ADR-0013):
// builds the Hebrew payload, fans out to every subscribed browser device, and automatically prunes
// subscriptions that have expired or been revoked (HTTP 404/410 "gone"). Best-effort: failures never
// fail or delay order creation.
import { buildNewOrderPushPayload, type Order } from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { logError } from '../errors.ts';

/**
 * Sends a Web Push notification to all registered collector devices for `order`.
 *
 * Best-effort (ADR-0013):
 * - If Web Push is disabled (`publicKey === null`), returns immediately without doing anything.
 * - Subscriptions returning `{ status: 'gone' }` are automatically pruned from the repository.
 * - Failed sends (`{ status: 'failed' }`) or network errors for one subscription do not prevent
 *   sending to remaining subscriptions.
 * - Any thrown error is caught and logged safely with {@link logError}; this function NEVER rejects.
 */
export async function notifyNewOrder(
  deps: Pick<AppDeps, 'pushSubscriptions' | 'push'>,
  order: Order,
): Promise<void> {
  try {
    if (deps.push.publicKey === null) {
      return;
    }

    const payload = buildNewOrderPushPayload(order);
    const subscriptions = await deps.pushSubscriptions.list();

    for (const sub of subscriptions) {
      try {
        const result = await deps.push.sender.send(sub, payload);
        if (result.status === 'gone') {
          await deps.pushSubscriptions.removeByEndpoint(sub.endpoint);
        }
      } catch (error) {
        logError(error);
      }
    }
  } catch (error) {
    logError(error);
  }
}
