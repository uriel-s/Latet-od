// In-memory PushSubscriptionsRepo: the fake that api and push tests run against (ADR-0013), so no
// test touches MongoDB Atlas.
import type { PushSubscription } from '@bottlerun/shared';
import type { PushSubscriptionsRepo } from './pushSubscriptionsRepo.ts';

/**
 * A fake {@link PushSubscriptionsRepo} backed by a `Map<string, PushSubscription>` keyed by
 * `endpoint`. Each instance has its own Map; not for production, where the api is serverless and
 * keeps no state between requests.
 */
export class InMemoryPushSubscriptionsRepo implements PushSubscriptionsRepo {
  private readonly subscriptions = new Map<string, PushSubscription>();

  save(subscription: PushSubscription): Promise<void> {
    const copy = structuredClone(subscription);
    this.subscriptions.set(copy.endpoint, copy);
    return Promise.resolve();
  }

  removeByEndpoint(endpoint: string): Promise<boolean> {
    return Promise.resolve(this.subscriptions.delete(endpoint));
  }

  list(): Promise<PushSubscription[]> {
    return Promise.resolve([...this.subscriptions.values()].map((sub) => structuredClone(sub)));
  }
}
