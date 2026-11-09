// The production PushSubscriptionsRepo (ADR-0013): collection `pushSubscriptions` in MongoDB Atlas.
// One document per collector browser device subscription, keyed by a unique index on `endpoint`.
// Every document read back is validated with `pushSubscriptionSchema` from `@bottlerun/shared`.
import type { Collection, Db, Filter, IndexDescription } from 'mongodb';
import { pushSubscriptionSchema, type PushSubscription } from '@bottlerun/shared';
import { indexesOnce } from '../db/indexes.ts';
import type { PushSubscriptionsRepo } from './pushSubscriptionsRepo.ts';

/** A Web Push subscription as stored in `pushSubscriptions`. */
export type PushSubscriptionDocument = PushSubscription;

/** Name of the unique index on the subscription's push service `endpoint`. */
export const PUSH_SUBSCRIPTION_ENDPOINT_INDEX = 'endpoint_unique';

/**
 * The indexes of `pushSubscriptions`, created by the repository before its first operation.
 *
 * `endpoint` is unique so concurrent `save()` calls for the same device upsert a single document
 * and `removeByEndpoint()` / `save()` lookups use the index.
 */
export const PUSH_SUBSCRIPTION_INDEXES: readonly IndexDescription[] = [
  { key: { endpoint: 1 }, name: PUSH_SUBSCRIPTION_ENDPOINT_INDEX, unique: true },
];

/** The Mongo `$set` update document produced by {@link toPushSubscriptionUpdate}. */
export interface PushSubscriptionUpdate {
  $set: PushSubscriptionDocument;
}

/**
 * {@link PushSubscriptionsRepo} on the `pushSubscriptions` collection of `db` (ADR-0013).
 *
 * Create one per process alongside the Mongo client: each instance ensures `PUSH_SUBSCRIPTION_INDEXES`
 * before its first operation.
 *
 * @example
 * describePushSubscriptionsRepoContract('MongoPushSubscriptionsRepo', async () => {
 *   await db.collection('pushSubscriptions').deleteMany({});
 *   return new MongoPushSubscriptionsRepo(db);
 * });
 */
export class MongoPushSubscriptionsRepo implements PushSubscriptionsRepo {
  private readonly subscriptions: Collection<PushSubscriptionDocument>;
  private readonly ensureIndexes: () => Promise<void>;

  constructor(db: Db) {
    this.subscriptions = db.collection<PushSubscriptionDocument>('pushSubscriptions');
    this.ensureIndexes = indexesOnce(this.subscriptions, PUSH_SUBSCRIPTION_INDEXES);
  }

  async save(subscription: PushSubscription): Promise<void> {
    await this.ensureIndexes();
    await this.subscriptions.updateOne(
      endpointFilter(subscription.endpoint),
      toPushSubscriptionUpdate(subscription),
      { upsert: true },
    );
  }

  async removeByEndpoint(endpoint: string): Promise<boolean> {
    await this.ensureIndexes();
    const result = await this.subscriptions.deleteOne(endpointFilter(endpoint));
    return result.deletedCount === 1;
  }

  async list(): Promise<PushSubscription[]> {
    await this.ensureIndexes();
    const docs = await this.subscriptions.find({}).toArray();
    return docs.map(toPushSubscription);
  }
}

/**
 * Matches the subscription with `endpoint`. Uses `$eq` so a string built from request data is
 * always compared as a literal value, never interpreted as a query operator.
 */
export function endpointFilter(endpoint: string): Filter<PushSubscriptionDocument> {
  return { endpoint: { $eq: endpoint } };
}

/**
 * Builds the `$set` update for upserting `subscription` by `endpoint`, copying `endpoint` and
 * `keys` (`p256dh`, `auth`) into a fresh object.
 */
export function toPushSubscriptionUpdate(subscription: PushSubscription): PushSubscriptionUpdate {
  return {
    $set: {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    },
  };
}

/**
 * Validates a document read from `pushSubscriptions` with {@link pushSubscriptionSchema}. Strips
 * Mongo's `_id` field first because `pushSubscriptionSchema` is a `z.strictObject` that rejects
 * unknown keys.
 */
export function toPushSubscription(doc: unknown): PushSubscription {
  if (typeof doc === 'object' && doc !== null && '_id' in doc) {
    const copy: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
    delete copy._id;
    return pushSubscriptionSchema.parse(copy);
  }
  return pushSubscriptionSchema.parse(doc);
}
