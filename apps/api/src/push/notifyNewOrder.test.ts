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
import { makeNewOrder } from '@bottlerun/shared/testing';
import { FakePushSender } from './fakePushSender.ts';
import { InMemoryPushSubscriptionsRepo } from './inMemoryPushSubscriptionsRepo.ts';
import { notifyNewOrder } from './notifyNewOrder.ts';
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

  it('logs a failed send as one warn line with the reason code only', async () => {
    const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(SUB_1);
    const sender = new FakePushSender(() => ({ status: 'failed', reason: 'http_401' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await notifyNewOrder({ pushSubscriptions, push: createFakePush({ sender }) }, SAMPLE_ORDER);

      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toStrictEqual({
        level: 'warn',
        event: 'push_failed',
        reason: 'http_401',
      });
      // Privacy: the endpoint of the device never reaches the log.
      expect(line).not.toContain(SUB_1.endpoint);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs one push_summary line with counts only (no endpoint or customer data)', async () => {
    const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(SUB_1);
    await pushSubscriptions.save(SUB_2);
    await pushSubscriptions.save(SUB_3);
    const sender = new FakePushSender((call) => {
      if (call.subscription.endpoint === SUB_2.endpoint) return { status: 'gone' };
      if (call.subscription.endpoint === SUB_3.endpoint) {
        return { status: 'failed', reason: 'http_403' };
      }
      return { status: 'sent' };
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await notifyNewOrder({ pushSubscriptions, push: createFakePush({ sender }) }, SAMPLE_ORDER);

      expect(info).toHaveBeenCalledTimes(1);
      const line = String(info.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toStrictEqual({
        level: 'info',
        event: 'push_summary',
        enabled: true,
        subscriptions: 3,
        sent: 1,
        gone: 1,
        failed: 1,
      });
      expect(line).not.toContain('push1.example.com');
      expect(line).not.toContain(SAMPLE_ORDER.contact.name);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('logs push_summary with zero subscriptions when none is stored', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await notifyNewOrder(
        {
          pushSubscriptions: new InMemoryPushSubscriptionsRepo(),
          push: createFakePush({ sender: new FakePushSender() }),
        },
        SAMPLE_ORDER,
      );

      expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toStrictEqual({
        level: 'info',
        event: 'push_summary',
        enabled: true,
        subscriptions: 0,
        sent: 0,
        gone: 0,
        failed: 0,
      });
    } finally {
      info.mockRestore();
    }
  });

  it('logs push_summary with enabled false when Web Push is disabled', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await notifyNewOrder(
        {
          pushSubscriptions: new InMemoryPushSubscriptionsRepo(),
          push: null,
        },
        SAMPLE_ORDER,
      );

      expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toStrictEqual({
        level: 'info',
        event: 'push_summary',
        enabled: false,
      });
    } finally {
      info.mockRestore();
    }
  });

  it('does nothing when Web Push is disabled (push is null)', async () => {
    const pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(SUB_1);
    const listSpy = vi.spyOn(pushSubscriptions, 'list');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await expect(
        notifyNewOrder({ pushSubscriptions, push: null }, SAMPLE_ORDER),
      ).resolves.toBeUndefined();

      // Disabled stops before reading the subscriptions, and keeps the stored one.
      expect(listSpy).not.toHaveBeenCalled();
      expect(await pushSubscriptions.list()).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
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
