// Unit tests of MongoPushSubscriptionsRepo's pure helpers (index specs, filter, update builder,
// document parser) and its collection wiring against an in-memory fake Mongo Db/Collection.
import { describe, expect, it, vi } from 'vitest';
import { ObjectId, type Db, type Filter, type IndexDescription } from 'mongodb';
import type { PushSubscription } from '@bottlerun/shared';
import { describePushSubscriptionsRepoContract } from './pushSubscriptionsRepo.contract.ts';
import {
  endpointFilter,
  MongoPushSubscriptionsRepo,
  PUSH_SUBSCRIPTION_ENDPOINT_INDEX,
  PUSH_SUBSCRIPTION_INDEXES,
  toPushSubscription,
  toPushSubscriptionUpdate,
  type PushSubscriptionDocument,
  type PushSubscriptionUpdate,
} from './mongoPushSubscriptionsRepo.ts';

function makeSubscription(overrides: Partial<PushSubscription> = {}): PushSubscription {
  return {
    endpoint: overrides.endpoint ?? 'https://fcm.googleapis.com/fcm/send/sub-1',
    keys: {
      p256dh: overrides.keys?.p256dh ?? 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFg',
      auth: overrides.keys?.auth ?? 'UUQM13vu25N2_b-9bN2B3g',
    },
  };
}

/**
 * Minimal in-memory fake of the Mongo `Db` / `Collection<PushSubscriptionDocument>` methods used
 * by `MongoPushSubscriptionsRepo`, storing documents with a real `ObjectId` `_id` like Mongo does.
 */
function makeFakeDb(): {
  db: Db;
  collectionNames: string[];
  createdIndexBatches: IndexDescription[][];
  docs: Map<string, PushSubscriptionDocument & { _id: ObjectId }>;
} {
  const docs = new Map<string, PushSubscriptionDocument & { _id: ObjectId }>();
  const collectionNames: string[] = [];
  const createdIndexBatches: IndexDescription[][] = [];

  const collection = {
    createIndexes(specs: IndexDescription[]): Promise<string[]> {
      createdIndexBatches.push(specs);
      return Promise.resolve(specs.map((spec) => spec.name ?? 'unnamed'));
    },
    updateOne(
      filter: Filter<PushSubscriptionDocument>,
      update: PushSubscriptionUpdate,
      options?: { upsert?: boolean },
    ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }> {
      const endpoint = extractEqEndpoint(filter);
      const existing = docs.get(endpoint);
      if (existing !== undefined) {
        docs.set(endpoint, { _id: existing._id, ...structuredClone(update.$set) });
        return Promise.resolve({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
      }
      if (options?.upsert === true) {
        docs.set(endpoint, { _id: new ObjectId(), ...structuredClone(update.$set) });
        return Promise.resolve({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 });
      }
      return Promise.resolve({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });
    },
    deleteOne(filter: Filter<PushSubscriptionDocument>): Promise<{ deletedCount: number }> {
      const endpoint = extractEqEndpoint(filter);
      const deleted = docs.delete(endpoint);
      return Promise.resolve({ deletedCount: deleted ? 1 : 0 });
    },
    find(): {
      toArray(): Promise<(PushSubscriptionDocument & { _id: ObjectId })[]>;
    } {
      return {
        toArray: () => Promise.resolve([...docs.values()].map((doc) => structuredClone(doc))),
      };
    },
  };

  const db = {
    collection(name: string) {
      collectionNames.push(name);
      return collection;
    },
  } as unknown as Db;

  return { db, collectionNames, createdIndexBatches, docs };
}

function extractEqEndpoint(filter: Filter<PushSubscriptionDocument>): string {
  const clause = filter.endpoint as { $eq?: unknown } | undefined;
  if (typeof clause !== 'object' || clause === null || typeof clause.$eq !== 'string') {
    throw new Error('Expected endpoint filter to use { endpoint: { $eq: <string> } }');
  }
  return clause.$eq;
}

describe('PUSH_SUBSCRIPTION_INDEXES', () => {
  it('defines a unique index on endpoint', () => {
    expect(PUSH_SUBSCRIPTION_INDEXES).toEqual([
      {
        key: { endpoint: 1 },
        name: PUSH_SUBSCRIPTION_ENDPOINT_INDEX,
        unique: true,
      },
    ]);
  });
});

describe('endpointFilter', () => {
  it('matches endpoint with $eq so the value is never interpreted as an operator', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/sub-1';

    expect(endpointFilter(endpoint)).toEqual({
      endpoint: { $eq: endpoint },
    });
  });
});

describe('toPushSubscriptionUpdate', () => {
  it('builds a $set update with endpoint and keys', () => {
    const sub = makeSubscription();

    expect(toPushSubscriptionUpdate(sub)).toEqual({
      $set: {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
      },
    });
  });

  it('copies keys so mutating the caller object after building the update does not affect $set', () => {
    const sub = makeSubscription();
    const update = toPushSubscriptionUpdate(sub);

    sub.keys.p256dh = 'mutated-p256dh';
    sub.keys.auth = 'mutated-auth';

    expect(update.$set.keys).toEqual(makeSubscription().keys);
  });
});

describe('toPushSubscription', () => {
  it('strips Mongo _id and returns the validated PushSubscription', () => {
    const sub = makeSubscription();
    const doc = { _id: new ObjectId(), ...sub };

    const parsed = toPushSubscription(doc);

    expect(parsed).toEqual(sub);
    expect('_id' in parsed).toBe(false);
  });

  it('accepts a valid PushSubscription without _id', () => {
    const sub = makeSubscription();

    expect(toPushSubscription(sub)).toEqual(sub);
  });

  it.each([
    ['null', null],
    ['a primitive', 'not-an-object'],
    [
      'a non-https endpoint',
      {
        _id: new ObjectId(),
        endpoint: 'http://fcm.googleapis.com/fcm/send/sub-1',
        keys: { p256dh: 'key', auth: 'auth' },
      },
    ],
    [
      'missing keys',
      {
        _id: new ObjectId(),
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
      },
    ],
    [
      'empty p256dh',
      {
        _id: new ObjectId(),
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
        keys: { p256dh: '   ', auth: 'auth' },
      },
    ],
    [
      'an unknown top-level property alongside _id',
      {
        _id: new ObjectId(),
        ...makeSubscription(),
        expirationTime: null,
      },
    ],
    [
      'an unknown nested property in keys',
      {
        _id: new ObjectId(),
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub-1',
        keys: { p256dh: 'key', auth: 'auth', extra: 'nope' },
      },
    ],
  ])('rejects a malformed stored document (%s)', (_label, badDoc) => {
    expect(() => toPushSubscription(badDoc)).toThrow();
  });
});

describe('MongoPushSubscriptionsRepo', () => {
  it('uses the pushSubscriptions collection and creates PUSH_SUBSCRIPTION_INDEXES once across operations', async () => {
    const { db, collectionNames, createdIndexBatches } = makeFakeDb();
    const repo = new MongoPushSubscriptionsRepo(db);
    const sub = makeSubscription();

    await repo.save(sub);
    await repo.list();
    await repo.removeByEndpoint(sub.endpoint);

    expect(collectionNames).toEqual(['pushSubscriptions']);
    expect(createdIndexBatches).toEqual([[...PUSH_SUBSCRIPTION_INDEXES]]);
  });

  it('list() skips a malformed stored document, keeps the valid ones, and logs only a count', async () => {
    const { db, docs } = makeFakeDb();
    const repo = new MongoPushSubscriptionsRepo(db);
    const valid = makeSubscription();
    await repo.save(valid);
    const badEndpoint = 'https://fcm.googleapis.com/fcm/send/corrupt';
    docs.set(badEndpoint, {
      _id: new ObjectId(),
      endpoint: badEndpoint,
      keys: { p256dh: '', auth: '' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(await repo.list()).toEqual([valid]);

      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toEqual({
        level: 'warn',
        event: 'push_subscriptions_invalid_skipped',
        skipped: 1,
      });
      // The corrupt document (it holds a push endpoint) never reaches the log.
      expect(line).not.toContain(badEndpoint);
    } finally {
      warn.mockRestore();
    }
  });
});

describePushSubscriptionsRepoContract('MongoPushSubscriptionsRepo', () => {
  const { db } = makeFakeDb();
  return new MongoPushSubscriptionsRepo(db);
});
