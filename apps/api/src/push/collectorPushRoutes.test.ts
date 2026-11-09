// Acceptance tests of /api/collector/push/* (ADR-0013) through supertest against createApp(fakes):
// no listen(), no port, no database, no network. Tests verify collector authentication, config
// reflection, and subscription registration and deregistration.
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  pushConfigResponseSchema,
  type PushConfigResponse,
  type PushSubscription,
} from '@bottlerun/shared';
import { createApp } from '../app.ts';
import { loggedInCookie } from '../auth/testSession.ts';
import { createFakeAuth, createFakeDeps, createFakePush } from '../fakeDeps.ts';
import { SAME_ORIGIN_HEADERS } from '../testRequest.ts';
import { DisabledPushSender } from './pushSender.ts';
import { InMemoryPushSubscriptionsRepo } from './inMemoryPushSubscriptionsRepo.ts';

const VALID_SUBSCRIPTION: PushSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/fake-device-subscription-1',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9AcDnVwTJaWwzsGEqTEQNo0PB0qGzxFlvmEEMBQWk_g328',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

const SECOND_SUBSCRIPTION: PushSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/fake-device-subscription-2',
  keys: {
    p256dh: 'BF5kL7kP2_fake_key_p256dh_abcdef1234567890',
    auth: 'authSecret123456',
  },
};

describe('Collector push routes: authentication', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(createFakeDeps());
  });

  it('answers 401 unauthenticated for GET /config without a session', async () => {
    const res = await request(app).get('/api/collector/push/config');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
  });

  it('answers 401 unauthenticated for POST /subscriptions without a session', async () => {
    const res = await request(app)
      .post('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .send(VALID_SUBSCRIPTION);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
  });

  it('answers 401 unauthenticated for DELETE /subscriptions without a session', async () => {
    const res = await request(app)
      .delete('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .send({ endpoint: VALID_SUBSCRIPTION.endpoint });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'unauthenticated' });
  });
});

describe('GET /api/collector/push/config', () => {
  it('returns 200 with enabled: true and public key when Web Push is configured', async () => {
    const auth = createFakeAuth();
    const cookie = loggedInCookie(auth, new Date());
    const push = createFakePush();
    const app = createApp(createFakeDeps({ auth, push }));

    const res = await request(app).get('/api/collector/push/config').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body: PushConfigResponse = pushConfigResponseSchema.parse(res.body);
    expect(body).toStrictEqual({
      enabled: true,
      publicKey: push.publicKey,
    });
  });

  it('returns 200 with enabled: false when Web Push is disabled', async () => {
    const auth = createFakeAuth();
    const cookie = loggedInCookie(auth, new Date());
    const push = { sender: new DisabledPushSender(), publicKey: null };
    const app = createApp(createFakeDeps({ auth, push }));

    const res = await request(app).get('/api/collector/push/config').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body: PushConfigResponse = pushConfigResponseSchema.parse(res.body);
    expect(body).toStrictEqual({ enabled: false });
  });
});

describe('POST /api/collector/push/subscriptions', () => {
  let pushSubscriptions: InMemoryPushSubscriptionsRepo;
  let cookie: string;
  let app: Express;

  beforeEach(() => {
    const auth = createFakeAuth();
    cookie = loggedInCookie(auth, new Date());
    pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    app = createApp(createFakeDeps({ auth, pushSubscriptions }));
  });

  it('stores a valid push subscription and answers 204 with no content', async () => {
    const res = await request(app)
      .post('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send(VALID_SUBSCRIPTION);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await pushSubscriptions.list()).toStrictEqual([VALID_SUBSCRIPTION]);
  });

  it('updates an existing subscription with the same endpoint', async () => {
    await pushSubscriptions.save(VALID_SUBSCRIPTION);
    const updated: PushSubscription = {
      ...VALID_SUBSCRIPTION,
      keys: { p256dh: 'new-key', auth: 'new-auth' },
    };

    const res = await request(app)
      .post('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send(updated);

    expect(res.status).toBe(204);
    expect(await pushSubscriptions.list()).toStrictEqual([updated]);
  });

  it.each([
    { label: 'missing endpoint', body: { keys: VALID_SUBSCRIPTION.keys } },
    {
      label: 'non-https endpoint',
      body: {
        endpoint: 'http://push.example.com/sub',
        keys: VALID_SUBSCRIPTION.keys,
      },
    },
    { label: 'missing keys', body: { endpoint: VALID_SUBSCRIPTION.endpoint } },
    {
      label: 'empty auth in keys',
      body: {
        endpoint: VALID_SUBSCRIPTION.endpoint,
        keys: { p256dh: VALID_SUBSCRIPTION.keys.p256dh, auth: '' },
      },
    },
    {
      label: 'extra unknown keys (strict validation)',
      body: {
        ...VALID_SUBSCRIPTION,
        expirationTime: null,
      },
    },
    { label: 'empty body', body: {} },
  ])('refuses $label with 400 invalid_push_subscription', async ({ body }) => {
    const res = await request(app)
      .post('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_push_subscription' });
    expect(await pushSubscriptions.list()).toEqual([]);
  });
});

describe('DELETE /api/collector/push/subscriptions', () => {
  let pushSubscriptions: InMemoryPushSubscriptionsRepo;
  let cookie: string;
  let app: Express;

  beforeEach(async () => {
    const auth = createFakeAuth();
    cookie = loggedInCookie(auth, new Date());
    pushSubscriptions = new InMemoryPushSubscriptionsRepo();
    await pushSubscriptions.save(VALID_SUBSCRIPTION);
    await pushSubscriptions.save(SECOND_SUBSCRIPTION);
    app = createApp(createFakeDeps({ auth, pushSubscriptions }));
  });

  it('removes an existing subscription and answers 204 with no content', async () => {
    const res = await request(app)
      .delete('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send({ endpoint: VALID_SUBSCRIPTION.endpoint });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await pushSubscriptions.list()).toStrictEqual([SECOND_SUBSCRIPTION]);
  });

  it('is idempotent: answers 204 even if subscription endpoint does not exist', async () => {
    const res = await request(app)
      .delete('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send({ endpoint: 'https://push.example.com/non-existent' });

    expect(res.status).toBe(204);
    expect(await pushSubscriptions.list()).toHaveLength(2);
  });

  it.each([
    { label: 'missing endpoint', body: {} },
    { label: 'non-https endpoint', body: { endpoint: 'http://insecure.example.com' } },
    { label: 'not an object', body: 'not-a-json-object' },
    {
      label: 'extra unknown keys (strict validation)',
      body: { endpoint: VALID_SUBSCRIPTION.endpoint, reason: 'unsubscribed' },
    },
  ])('refuses $label with 400 invalid_push_subscription', async ({ body }) => {
    const res = await request(app)
      .delete('/api/collector/push/subscriptions')
      .set(SAME_ORIGIN_HEADERS)
      .set('Cookie', cookie)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'invalid_push_subscription' });
    expect(await pushSubscriptions.list()).toHaveLength(2);
  });
});
