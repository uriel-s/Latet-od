import { describe, expect, it } from 'vitest';
import {
  NEW_ORDER_PUSH_TITLE,
  NEW_ORDER_PUSH_URL,
  PUSH_ENDPOINT_MAX_LENGTH,
  PUSH_KEY_MAX_LENGTH,
  buildNewOrderPushPayload,
  pushConfigResponseSchema,
  pushNotificationPayloadSchema,
  pushSubscriptionSchema,
  unsubscribePushRequestSchema,
} from './pushApi.ts';

const validSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

describe('pushSubscriptionSchema', () => {
  it('accepts a valid https push subscription and trims keys', () => {
    expect(
      pushSubscriptionSchema.parse({
        endpoint: validSubscription.endpoint,
        keys: {
          p256dh: `  ${validSubscription.keys.p256dh}  `,
          auth: ` ${validSubscription.keys.auth} `,
        },
      }),
    ).toEqual(validSubscription);
  });

  it('rejects non-https endpoints and invalid URLs', () => {
    expect(
      pushSubscriptionSchema.safeParse({
        ...validSubscription,
        endpoint: 'http://fcm.googleapis.com/fcm/send/abc123',
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        ...validSubscription,
        endpoint: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        ...validSubscription,
        endpoint: 'not-a-url',
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        ...validSubscription,
        endpoint: '',
      }).success,
    ).toBe(false);
  });

  it('rejects an endpoint exceeding PUSH_ENDPOINT_MAX_LENGTH', () => {
    const prefix = 'https://fcm.googleapis.com/';
    const exact = prefix + 'a'.repeat(PUSH_ENDPOINT_MAX_LENGTH - prefix.length);
    expect(
      pushSubscriptionSchema.safeParse({ ...validSubscription, endpoint: exact }).success,
    ).toBe(true);
    expect(
      pushSubscriptionSchema.safeParse({ ...validSubscription, endpoint: `${exact}a` }).success,
    ).toBe(false);
  });

  it('rejects missing, empty, whitespace-only, or overly long keys', () => {
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: validSubscription.endpoint,
        keys: { p256dh: '', auth: validSubscription.keys.auth },
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: validSubscription.endpoint,
        keys: { p256dh: '   ', auth: validSubscription.keys.auth },
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: validSubscription.endpoint,
        keys: { p256dh: validSubscription.keys.p256dh, auth: '' },
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: validSubscription.endpoint,
        keys: { p256dh: 'k'.repeat(PUSH_KEY_MAX_LENGTH + 1), auth: validSubscription.keys.auth },
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: validSubscription.endpoint,
        keys: { p256dh: validSubscription.keys.p256dh },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown properties on the subscription or keys object', () => {
    expect(
      pushSubscriptionSchema.safeParse({
        ...validSubscription,
        expirationTime: null,
      }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: validSubscription.endpoint,
        keys: { ...validSubscription.keys, extra: '123' },
      }).success,
    ).toBe(false);
  });
});

describe('unsubscribePushRequestSchema', () => {
  it('accepts a valid https endpoint', () => {
    expect(unsubscribePushRequestSchema.parse({ endpoint: validSubscription.endpoint })).toEqual({
      endpoint: validSubscription.endpoint,
    });
  });

  it('rejects non-https endpoints, missing endpoint, or unknown properties', () => {
    expect(
      unsubscribePushRequestSchema.safeParse({ endpoint: 'http://example.com/push' }).success,
    ).toBe(false);
    expect(unsubscribePushRequestSchema.safeParse({}).success).toBe(false);
    expect(
      unsubscribePushRequestSchema.safeParse({
        endpoint: validSubscription.endpoint,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('pushConfigResponseSchema', () => {
  it('accepts enabled: true with a non-empty publicKey and enabled: false without one', () => {
    expect(
      pushConfigResponseSchema.parse({ enabled: true, publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa' }),
    ).toEqual({ enabled: true, publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa' });
    expect(pushConfigResponseSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('rejects enabled: true without publicKey or with an empty publicKey', () => {
    expect(pushConfigResponseSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(pushConfigResponseSchema.safeParse({ enabled: true, publicKey: '   ' }).success).toBe(
      false,
    );
  });

  it('rejects unknown properties', () => {
    expect(
      pushConfigResponseSchema.safeParse({ enabled: false, publicKey: 'should-not-be-here' })
        .success,
    ).toBe(false);
  });
});

describe('pushNotificationPayloadSchema & buildNewOrderPushPayload', () => {
  it('builds a valid Hebrew notification payload for a new order', () => {
    const payload = buildNewOrderPushPayload({
      contact: { name: 'שרה כהן', phone: '+972501234567', method: 'whatsapp' },
      address: {
        streetName: 'נחל דולב',
        houseNumber: '12א',
        bottlesSpot: 'buildingEntrance',
      },
      bottlesEstimated: 45,
    });

    expect(payload).toEqual({
      title: NEW_ORDER_PUSH_TITLE,
      body: 'שרה כהן · נחל דולב 12א · כ־45 בקבוקים',
      url: NEW_ORDER_PUSH_URL,
    });
    expect(pushNotificationPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects empty fields or unknown properties in pushNotificationPayloadSchema', () => {
    expect(
      pushNotificationPayloadSchema.safeParse({ title: '', body: 'גוף', url: '/app/orders' })
        .success,
    ).toBe(false);
    expect(
      pushNotificationPayloadSchema.safeParse({
        title: 'כותרת',
        body: 'גוף',
        url: '/app/orders',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
