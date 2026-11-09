// /api/collector/push: the api for managing the collector's Web Push notifications (ADR-0013):
// reading whether VAPID is enabled and the public key (GET /config), registering a device's push
// subscription (POST /subscriptions), and unregistering when notifications are disabled (DELETE
// /subscriptions). Mounted after requireCollector, so every endpoint requires an authenticated
// collector session (ADR-0004).
import { Router } from 'express';
import {
  pushSubscriptionSchema,
  unsubscribePushRequestSchema,
  type InvalidPushSubscriptionErrorBody,
  type PushConfigResponse,
} from '@bottlerun/shared';
import type { AppDeps } from '../deps.ts';

/**
 * Builds the router for /api/collector/push.
 *
 * Mount it with `app.use('/api/collector/push', createCollectorPushRouter(deps))`, after the
 * Origin check, the JSON body parser and `requireCollector` (which answers 401 without a valid
 * session cookie and sets `Cache-Control: no-store` on every answer).
 *
 * Endpoints:
 * - `GET /config`: 200 {@link PushConfigResponse} with `{ enabled: true, publicKey }` when VAPID is
 *   configured in the api env, or `{ enabled: false }` when Web Push is disabled.
 * - `POST /subscriptions`: 204 no content on success (upsert subscription by endpoint);
 *   400 {@link InvalidPushSubscriptionErrorBody} if body fails {@link pushSubscriptionSchema}.
 * - `DELETE /subscriptions`: 204 no content on success (idempotent remove by endpoint);
 *   400 {@link InvalidPushSubscriptionErrorBody} if body fails {@link unsubscribePushRequestSchema}.
 */
export function createCollectorPushRouter(
  deps: Pick<AppDeps, 'pushSubscriptions' | 'push'>,
): Router {
  const router = Router();

  router.get('/config', (_req, res) => {
    const body: PushConfigResponse =
      deps.push.publicKey !== null
        ? { enabled: true, publicKey: deps.push.publicKey }
        : { enabled: false };
    res.json(body);
  });

  router.post('/subscriptions', async (req, res) => {
    const parsed = pushSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      const error: InvalidPushSubscriptionErrorBody = { error: 'invalid_push_subscription' };
      res.status(400).json(error);
      return;
    }

    await deps.pushSubscriptions.save(parsed.data);
    res.status(204).end();
  });

  router.delete('/subscriptions', async (req, res) => {
    const parsed = unsubscribePushRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const error: InvalidPushSubscriptionErrorBody = { error: 'invalid_push_subscription' };
      res.status(400).json(error);
      return;
    }

    await deps.pushSubscriptions.removeByEndpoint(parsed.data.endpoint);
    res.status(204).end();
  });

  return router;
}
