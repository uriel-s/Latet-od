// The collector's Web Push endpoints: /api/collector/push/* (ADR-0013). Sent through `request()`
// (request.ts), which handles what every endpoint shares.
//
// Behind the login like the other collector routes: a 401 is `loggedOut`, and nothing is retried.
import {
  pushConfigResponseSchema,
  type PushConfigResponse,
  type PushSubscription,
  type UnsubscribePushRequest,
} from '@bottlerun/shared';
import { FRESH_GET, globalFetch, jsonInit, parsed, request, type FetchFn } from './request.ts';

const COLLECTOR_PUSH_PATH = '/api/collector/push';

/** How GET /api/collector/push/config ended. */
export type PushConfigOutcome =
  { kind: 'loaded'; config: PushConfigResponse } | { kind: 'loggedOut' } | { kind: 'failed' };

/** Fetches whether Web Push is enabled and its public VAPID key from GET /api/collector/push/config. */
export async function fetchPushConfig(fetchFn: FetchFn = globalFetch): Promise<PushConfigOutcome> {
  return request<PushConfigOutcome>(fetchFn, {
    path: `${COLLECTOR_PUSH_PATH}/config`,
    init: FRESH_GET,
    behindLogin: true,
    on: { 200: parsed(pushConfigResponseSchema, (config) => ({ kind: 'loaded', config })) },
  });
}

/** How saving a push subscription ended. */
export type SavePushSubscriptionOutcome =
  { kind: 'saved' } | { kind: 'loggedOut' } | { kind: 'failed' };

/** Saves a Web Push subscription with POST /api/collector/push/subscribe (ADR-0013). */
export async function savePushSubscription(
  subscription: PushSubscription,
  fetchFn: FetchFn = globalFetch,
): Promise<SavePushSubscriptionOutcome> {
  return request<SavePushSubscriptionOutcome>(fetchFn, {
    path: `${COLLECTOR_PUSH_PATH}/subscribe`,
    init: jsonInit('POST', subscription),
    behindLogin: true,
    on: { 204: () => ({ kind: 'saved' }) },
  });
}

/** How deleting a push subscription ended. */
export type DeletePushSubscriptionOutcome =
  { kind: 'deleted' } | { kind: 'loggedOut' } | { kind: 'failed' };

/** Deletes a Web Push subscription with POST /api/collector/push/unsubscribe (ADR-0013). */
export async function deletePushSubscription(
  endpoint: string,
  fetchFn: FetchFn = globalFetch,
): Promise<DeletePushSubscriptionOutcome> {
  const body: UnsubscribePushRequest = { endpoint };
  return request<DeletePushSubscriptionOutcome>(fetchFn, {
    path: `${COLLECTOR_PUSH_PATH}/unsubscribe`,
    init: jsonInit('POST', body),
    behindLogin: true,
    on: { 204: () => ({ kind: 'deleted' }) },
  });
}
