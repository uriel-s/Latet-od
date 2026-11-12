// /api/collector/push: the api for managing the collector's Web Push notifications (ADR-0013):
// reading whether VAPID is enabled and the public key (GET /config), registering a device's push
// subscription (POST /subscribe), and unregistering when notifications are disabled (POST
// /unsubscribe). Mounted after requireCollector, so every
// endpoint requires an authenticated collector session (ADR-0004).
import { Router, type RequestHandler } from 'express';
import {
  pushSubscriptionSchema,
  unsubscribePushRequestSchema,
  type InvalidPushSubscriptionErrorBody,
  type PushConfigResponse,
  type PushNotConfiguredErrorBody,
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
 * - `POST /subscribe`: 204 no content on success (upsert subscription by endpoint);
 *   400 {@link InvalidPushSubscriptionErrorBody} if body fails {@link pushSubscriptionSchema};
 *   503 {@link PushNotConfiguredErrorBody} if Web Push is disabled.
 * - `POST /unsubscribe`: 204 no content on success (idempotent remove by endpoint);
 *   400 {@link InvalidPushSubscriptionErrorBody} if body fails {@link unsubscribePushRequestSchema}.
 */
export function createCollectorPushRouter(
  deps: Pick<AppDeps, 'pushSubscriptions' | 'push'>,
): Router {
  const router = Router();

  router.get('/config', (_req, res) => {
    const body: PushConfigResponse =
      deps.push === null ? { enabled: false } : { enabled: true, publicKey: deps.push.publicKey };
    res.json(body);
  });

  const handleSubscribe: RequestHandler = async (req, res) => {
    if (deps.push === null) {
      const error: PushNotConfiguredErrorBody = { error: 'push_not_configured' };
      res.status(503).json(error);
      return;
    }

    const parsed = pushSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      const error: InvalidPushSubscriptionErrorBody = { error: 'invalid_push_subscription' };
      res.status(400).json(error);
      return;
    }

    await deps.pushSubscriptions.save(parsed.data);
    res.status(204).end();
  };

  const handleUnsubscribe: RequestHandler = async (req, res) => {
    const parsed = unsubscribePushRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const error: InvalidPushSubscriptionErrorBody = { error: 'invalid_push_subscription' };
      res.status(400).json(error);
      return;
    }

    await deps.pushSubscriptions.removeByEndpoint(parsed.data.endpoint);
    res.status(204).end();
  };

  router.post('/subscribe', handleSubscribe);
  router.post('/unsubscribe', handleUnsubscribe);

  return router;
}
