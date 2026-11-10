// Stored Web Push subscriptions of Yoel's devices (ADR-0013): one entry per browser push
// `endpoint`, holding the ECDH `p256dh` key and `auth` secret needed to encrypt notifications when
// a new order arrives from the public form. The api is serverless, so production stores them in
// MongoDB (`pushSubscriptions`); tests use the in-memory fake.
import type { PushSubscription } from '@bottlerun/shared';

/**
 * Repository of collector Web Push subscriptions (ADR-0013).
 *
 * Subscriptions are keyed by `subscription.endpoint`: re-subscribing from a browser whose endpoint
 * already exists updates its `keys` in place without creating a duplicate entry. Every subscription
 * passed into or returned from the repository is a defensive copy so caller mutations never affect
 * stored state.
 */
export interface PushSubscriptionsRepo {
  /**
   * Stores `subscription` keyed by `subscription.endpoint`. If a subscription with the same
   * `endpoint` already exists, replaces its `keys` (`p256dh`, `auth`) in place without creating a
   * second entry.
   */
  save(subscription: PushSubscription): Promise<void>;

  /**
   * Deletes the subscription with `endpoint`. Returns `true` when a matching subscription existed
   * and was removed, or `false` when `endpoint` was not stored.
   */
  removeByEndpoint(endpoint: string): Promise<boolean>;

  /** Returns all stored subscriptions, each as a defensive copy. */
  list(): Promise<PushSubscription[]>;
}
