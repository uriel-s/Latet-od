// The behaviour every PushSubscriptionsRepo must have, as a reusable Vitest suite: the in-memory
// fake runs it in inMemoryPushSubscriptionsRepo.test.ts and the Mongo repo satisfies the same
// contract. Deliberately not named *.test.ts: it only declares tests when an implementation calls it.
import { beforeEach, describe, expect, it } from 'vitest';
import type { PushSubscription } from '@bottlerun/shared';
import type { PushSubscriptionsRepo } from './pushSubscriptionsRepo.ts';

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
 * Declares the {@link PushSubscriptionsRepo} contract tests for one implementation.
 *
 * @param name Shown in the test names, e.g. `'InMemoryPushSubscriptionsRepo'`.
 * @param makeRepo Called before every test; must return an EMPTY repository.
 */
export function describePushSubscriptionsRepoContract(
  name: string,
  makeRepo: () => PushSubscriptionsRepo | Promise<PushSubscriptionsRepo>,
): void {
  describe(`PushSubscriptionsRepo contract: ${name}`, () => {
    let repo: PushSubscriptionsRepo;

    beforeEach(async () => {
      repo = await makeRepo();
    });

    it('starts empty', async () => {
      expect(await repo.list()).toEqual([]);
    });

    it('saves and lists one and multiple subscriptions', async () => {
      const first = makeSubscription({
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      });
      const second = makeSubscription({
        endpoint: 'https://web.push.apple.com/Q1w2e3r4',
        keys: { p256dh: 'apple-p256dh-key', auth: 'apple-auth-secret' },
      });

      await repo.save(first);
      expect(await repo.list()).toEqual([first]);

      await repo.save(second);
      const all = await repo.list();
      expect(all).toHaveLength(2);
      expect(all).toEqual(expect.arrayContaining([first, second]));
    });

    it('upserts by endpoint, replacing keys in place without duplicating the entry', async () => {
      const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1';
      const initial = makeSubscription({
        endpoint,
        keys: { p256dh: 'old-p256dh', auth: 'old-auth' },
      });
      const other = makeSubscription({
        endpoint: 'https://web.push.apple.com/other-device',
      });
      const updated = makeSubscription({
        endpoint,
        keys: { p256dh: 'new-p256dh', auth: 'new-auth' },
      });

      await repo.save(initial);
      await repo.save(other);
      await repo.save(updated);

      const all = await repo.list();
      expect(all).toHaveLength(2);
      expect(all).toEqual(expect.arrayContaining([updated, other]));
    });

    it('removes only the matching endpoint and reports whether one existed', async () => {
      const first = makeSubscription({
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      });
      const second = makeSubscription({
        endpoint: 'https://web.push.apple.com/device-2',
      });
      await repo.save(first);
      await repo.save(second);

      expect(await repo.removeByEndpoint(first.endpoint)).toBe(true);
      expect(await repo.list()).toEqual([second]);

      // Removing an already removed or unknown endpoint returns false and leaves the rest untouched.
      expect(await repo.removeByEndpoint(first.endpoint)).toBe(false);
      expect(await repo.removeByEndpoint('https://fcm.googleapis.com/fcm/send/unknown')).toBe(
        false,
      );
      expect(await repo.list()).toEqual([second]);
    });

    it('stores a defensive copy on save so mutating the caller object does not change stored state', async () => {
      const sub = makeSubscription();
      await repo.save(sub);

      sub.endpoint = 'https://fcm.googleapis.com/fcm/send/mutated';
      sub.keys.p256dh = 'mutated-p256dh';
      sub.keys.auth = 'mutated-auth';

      expect(await repo.list()).toEqual([makeSubscription()]);
    });

    it('returns defensive copies from list so mutating the returned array or objects does not change stored state', async () => {
      const sub = makeSubscription();
      await repo.save(sub);

      const listed = await repo.list();
      listed[0]!.keys.p256dh = 'mutated-in-list';
      listed[0]!.keys.auth = 'mutated-auth-in-list';
      listed.pop();

      expect(await repo.list()).toEqual([makeSubscription()]);
    });
  });
}
