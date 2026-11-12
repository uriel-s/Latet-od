// How the collector (Yoel) is notified when a new order arrives from the public form (ADR-0013):
// builds the Hebrew payload, fans out to every subscribed browser device, and automatically prunes
// subscriptions that have expired or been revoked (HTTP 404/410 "gone"). Best-effort: failures never
// fail order creation. The caller awaits this (a serverless function can be frozen once the
// response is sent), so a slow push service delays the customer's reply by at most the sender's
// timeout.
import { buildNewOrderPushPayload, type Order } from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';
import { logError } from '../errors.ts';

/**
 * Sends a Web Push notification to all registered collector devices for `order`.
 *
 * Best-effort (ADR-0013):
 * - If Web Push is disabled (`deps.push === null`), logs that and returns without sending.
 * - Subscriptions returning `{ status: 'gone' }` are automatically pruned from the repository.
 * - Failed sends (`{ status: 'failed' }`) or network errors for one subscription are logged (reason
 *   code only) and do not prevent sending to remaining subscriptions.
 * - Any thrown error is caught and logged safely with {@link logError}; this function NEVER rejects.
 */
export async function notifyNewOrder(
  deps: Pick<AppDeps, 'pushSubscriptions' | 'push'>,
  order: Order,
): Promise<void> {
  try {
    const push = deps.push;
    if (push === null) {
      logPushSummary({ enabled: false });
      return;
    }

    const payload = buildNewOrderPushPayload(order);
    const subscriptions = await deps.pushSubscriptions.list();
    const counts = { sent: 0, gone: 0, failed: 0 };

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          const result = await push.sender.send(sub, payload);
          counts[result.status] += 1;
          if (result.status === 'gone') {
            await deps.pushSubscriptions.removeByEndpoint(sub.endpoint);
          } else if (result.status === 'failed') {
            // ADR-0013 §3: a failed send is logged, never silent. Without this line, wrong VAPID
            // keys (http_401/403) or a push-service outage would leave Yoel with no notifications
            // and no trace. `reason` is a short code with no subscription or customer data.
            console.warn(
              JSON.stringify({ level: 'warn', event: 'push_failed', reason: result.reason }),
            );
          }
        } catch (error) {
          logError(error);
        }
      }),
    );

    logPushSummary({ enabled: true, subscriptions: subscriptions.length, ...counts });
  } catch (error) {
    logError(error);
  }
}

/**
 * Logs ONE info line per new order saying what the notification step did. Without it a successful
 * send, "no subscription stored" and "Web Push disabled" all leave the logs empty, so "Yoel gets
 * no notification" cannot be diagnosed on Vercel. Counts only: no endpoint, name or address.
 */
function logPushSummary(summary: {
  enabled: boolean;
  subscriptions?: number;
  sent?: number;
  gone?: number;
  failed?: number;
}): void {
  console.info(JSON.stringify({ level: 'info', event: 'push_summary', ...summary }));
}
