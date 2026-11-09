// Acceptance tests of notifyNewOrder (ADR-0013): fan-out to registered collector push
// subscriptions, automatic pruning of expired/revoked subscriptions (404/410 gone), safe handling
// of sender failures, and disabled push mode.
import { describe, expect, it, vi } from 'vitest';
import {
  NEW_ORDER_PUSH_TITLE,
  NEW_ORDER_PUSH_URL,
  type Order,
  type PushSubscription,
} from '@bottlerun/shared';
import { createFakePush } from '../fakeDeps.ts';
import { makeNewOrder } from '../orders/makeOrder.ts';
import { FakePushSender } from './fakePushSender.ts';
import { InMemoryPushSubscriptionsRepo } from './inMemoryPushSubscriptionsRepo.ts';
import { notifyNewOrder } from './notifyNewOrder.ts';
import { DisabledPushSender } from './pushSender.ts';
import type { PushSubscriptionsRepo } from './pushSubscriptionsRepo.ts';

const SUB_1: PushSubscription = {
  endpoint: 'https://push1.example.com/device-1',
  keys: { p256dh: 'key-1', auth: 'auth-1' },
};

const SUB_2: PushSubscription = {
  endpoint: 'https://push2.example.com/device-2',
  keys: { p256dh: 'key-2', auth: 'auth-2' },
};

const SUB_3: PushSubscription = {
  endpoint: 'https://push3.example.com/device-3',
  keys: { p256dh: 'key-3', auth: 'auth-3' },
};

const SAMPLE_ORDER: Order = {
  ...makeNewOrder({
    contact: { name: 'ישראל ישראלי', phone: '+972501234567', method: 'whatsapp' },
    address: { streetName: 'נחל דולב', houseNumber: '15', bottlesSpot: 'apartmentDoor' },
    bottlesEstimated: 60,
  }),
  id: 'order-1234567890abcdef123456',
};

describe('notifyNewOrder', () => {
  it('sends the correct notification payload to all registered subscriptions', async () => {
    const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(SUB_1);
    await pushSubscriptions.save(SUB_2);

    const sender = new FakePushSender();
    const push = createFakePush({ sender });

    await notifyNewOrder({ pushSubscriptions, push }, SAMPLE_ORDER);

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]).toStrictEqual({
      subscription: SUB_1,
      payload: {
        title: NEW_ORDER_PUSH_TITLE,
        body: 'ישראל ישראלי · נחל דולב 15 · כ־60 בקבוקים',
        url: NEW_ORDER_PUSH_URL,
      },
    });
    expect(sender.sent[1]).toStrictEqual({
      subscription: SUB_2,
      payload: {
        title: NEW_ORDER_PUSH_TITLE,
        body: 'ישראל ישראלי · נחל דולב 15 · כ־60 בקבוקים',
        url: NEW_ORDER_PUSH_URL,
      },
    });
  });

  it('automatically removes subscriptions that return { status: "gone" }', async () => {
    const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(SUB_1);
    await pushSubscriptions.save(SUB_2);
    await pushSubscriptions.save(SUB_3);

    const sender = new FakePushSender((call) => {
      if (call.subscription.endpoint === SUB_1.endpoint) return { status: 'gone' };
      if (call.subscription.endpoint === SUB_3.endpoint) return { status: 'gone' };
      return { status: 'sent' };
    });
    const push = createFakePush({ sender });

    await notifyNewOrder({ pushSubscriptions, push }, SAMPLE_ORDER);

    expect(sender.sent).toHaveLength(3);
    const remaining = await pushSubscriptions.list();
    expect(remaining).toStrictEqual([SUB_2]);
  });

  it('continues sending to remaining subscriptions when one returns { status: "failed" }', async () => {
    const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(SUB_1);
    await pushSubscriptions.save(SUB_2);

    const sender = new FakePushSender((call) => {
      if (call.subscription.endpoint === SUB_1.endpoint) {
        return { status: 'failed', reason: '503 Service Unavailable' };
      }
      return { status: 'sent' };
    });
    const push = createFakePush({ sender });

    await notifyNewOrder({ pushSubscriptions, push }, SAMPLE_ORDER);

    expect(sender.sent).toHaveLength(2);
    // Failed does not prune the subscription
    expect(await pushSubscriptions.list()).toHaveLength(2);
  });

  it('does nothing when Web Push is disabled (publicKey is null)', async () => {
    const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(SUB_1);

    const sender = new FakePushSender();
    const push = { sender: new DisabledPushSender(), publicKey: null };

    await notifyNewOrder({ pushSubscriptions, push }, SAMPLE_ORDER);

    expect(sender.sent).toHaveLength(0);
    expect(await pushSubscriptions.list()).toHaveLength(1);
  });

  it('continues sending to remaining subscriptions when sender throws an unexpected error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
      await pushSubscriptions.save(SUB_1);
      await pushSubscriptions.save(SUB_2);

      const sender = new FakePushSender((call) => {
        if (call.subscription.endpoint === SUB_1.endpoint) {
          throw new Error('Push endpoint network drop');
        }
        return { status: 'sent' };
      });
      const push = createFakePush({ sender });

      await expect(
        notifyNewOrder({ pushSubscriptions, push }, SAMPLE_ORDER),
      ).resolves.toBeUndefined();

      expect(sender.sent).toHaveLength(2);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('catches any unexpected errors without rejecting when repository list fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failingRepo: PushSubscriptionsRepo = {
        save: () => Promise.resolve(),
        removeByEndpoint: () => Promise.resolve(true),
        list: () => Promise.reject(new Error('Mongo connection failed')),
      };
      const sender = new FakePushSender();
      const push = createFakePush({ sender });

      await expect(
        notifyNewOrder({ pushSubscriptions: failingRepo, push }, SAMPLE_ORDER),
      ).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
