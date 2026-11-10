// Unit tests for VAPID key parsing/signing (RFC 8292), Web Push aes128gcm encryption (RFC 8291 +
// RFC 8188), WebPushSender, DisabledPushSender, and FakePushSender.
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto';
import type { PushNotificationPayload, PushSubscription } from '@bottlerun/shared';
import { describe, expect, it, vi } from 'vitest';
import { FAKE_VAPID_PUBLIC_KEY, FakePushSender } from './fakePushSender.ts';
import { DisabledPushSender, type PushSender } from './pushSender.ts';
import {
  buildVapidAuthHeader,
  encryptWebPushPayload,
  generateVapidKeys,
  parseVapidKeys,
  WebPushSender,
} from './webPushSender.ts';

const SAMPLE_PAYLOAD: PushNotificationPayload = {
  title: 'הזמנה חדשה — לתת עוד',
  body: 'שרה כהן · נחל דולב 12 · כ־30 בקבוקים',
  url: '/app/orders',
};

/** Generates a real P-256 browser subscription and retains its ECDH instance + auth secret for decryption. */
function makeBrowserSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/sub-1') {
  const uaEcdh = createECDH('prime256v1');
  const uaPublic = uaEcdh.generateKeys();
  const authSecret = randomBytes(16);
  const subscription: PushSubscription = {
    endpoint,
    keys: {
      p256dh: uaPublic.toString('base64url'),
      auth: authSecret.toString('base64url'),
    },
  };
  return { subscription, uaEcdh, uaPublic, authSecret };
}

/** Decrypts an RFC 8291 / RFC 8188 `aes128gcm` body as a browser user agent would. */
function decryptWebPushRecord(
  encrypted: Buffer,
  uaEcdh: ReturnType<typeof createECDH>,
  uaPublic: Buffer,
  authSecret: Buffer,
): { rs: number; idlen: number; delimitedPlaintext: Buffer } {
  const salt = encrypted.subarray(0, 16);
  const rs = encrypted.readUInt32BE(16);
  const idlen = encrypted.readUInt8(20);
  const asPublic = encrypted.subarray(21, 21 + idlen);
  const bodyAndTag = encrypted.subarray(21 + idlen);
  const ciphertext = bodyAndTag.subarray(0, bodyAndTag.length - 16);
  const authTag = bodyAndTag.subarray(bodyAndTag.length - 16);

  const sharedSecret = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12),
  );

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(authTag);
  const delimitedPlaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { rs, idlen, delimitedPlaintext };
}

describe('generateVapidKeys & parseVapidKeys', () => {
  it('generates a valid P-256 key pair accepted by parseVapidKeys', () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const parsed = parseVapidKeys(publicKey, privateKey);

    expect(parsed.publicKey).toBe(publicKey);
    expect(parsed.publicKeyBytes.length).toBe(65);
    expect(parsed.publicKeyBytes[0]).toBe(0x04);
  });

  it('accepts a private key whose leading zero byte was stripped (the .env.example recipe)', () => {
    // A scalar with a leading 0x00: `getPrivateKey()` returns only 31 bytes for such a key.
    const fullScalar = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(31, 0x11)]);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(fullScalar);
    const publicKey = ecdh.getPublicKey().toString('base64url');
    const strippedPrivate = fullScalar.subarray(1).toString('base64url');

    const parsed = parseVapidKeys(publicKey, strippedPrivate);

    expect(parsed.publicKey).toBe(publicKey);
  });

  it('rejects a mismatched public and private key pair without leaking either value', () => {
    const first = generateVapidKeys();
    const second = generateVapidKeys();

    let thrown: Error | undefined;
    try {
      parseVapidKeys(first.publicKey, second.privateKey);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY do not match/u);
    expect(thrown?.message).not.toContain(first.publicKey);
    expect(thrown?.message).not.toContain(second.privateKey);
  });

  it.each([
    ['wrong length (32 bytes instead of 65)', randomBytes(32).toString('base64url')],
    [
      'wrong prefix byte (0x02 compressed point)',
      Buffer.concat([Buffer.from([0x02]), randomBytes(64)]).toString('base64url'),
    ],
    ['invalid base64url characters', 'not+valid/base64url==='],
    ['empty string', ''],
  ])('rejects an invalid public key (%s) without repeating the value', (_label, badPublic) => {
    const { privateKey } = generateVapidKeys();

    let thrown: Error | undefined;
    try {
      parseVapidKeys(badPublic, privateKey);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/^VAPID_PUBLIC_KEY is invalid/u);
    if (badPublic) {
      expect(thrown?.message).not.toContain(badPublic);
    }
    expect(thrown?.message).not.toContain(privateKey);
  });

  it.each([
    ['wrong length (16 bytes instead of 32)', randomBytes(16).toString('base64url')],
    ['invalid base64url characters', 'bad+private/key==='],
    ['zero scalar (all 0x00 bytes)', Buffer.alloc(32, 0).toString('base64url')],
  ])('rejects an invalid private key (%s) without repeating the value', (_label, badPrivate) => {
    const { publicKey } = generateVapidKeys();

    let thrown: Error | undefined;
    try {
      parseVapidKeys(publicKey, badPrivate);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/^VAPID_PRIVATE_KEY is invalid/u);
    expect(thrown?.message).not.toContain(badPrivate);
    expect(thrown?.message).not.toContain(publicKey);
  });
});

describe('buildVapidAuthHeader', () => {
  it('builds a valid RFC 8292 Authorization header with a verifiable ES256 JWT signature', () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const vapidKeys = parseVapidKeys(publicKey, privateKey);
    const nowMs = Date.UTC(2026, 10, 9, 12, 0, 0);

    const header = buildVapidAuthHeader({
      endpoint: 'https://web.push.apple.com/QEd9-example-token',
      subject: 'mailto:yoel@example.com',
      vapidKeys,
      nowMs,
    });

    const match = /^vapid t=(?<jwt>[^,]+), k=(?<key>.+)$/u.exec(header);
    expect(match?.groups).toBeDefined();
    expect(match?.groups?.key).toBe(publicKey);

    const jwt = match?.groups?.jwt ?? '';
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const decodedHeader = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
      typ: string;
      alg: string;
    };
    expect(decodedHeader).toEqual({ typ: 'JWT', alg: 'ES256' });

    const decodedPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(decodedPayload).toEqual({
      aud: 'https://web.push.apple.com',
      exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
      sub: 'mailto:yoel@example.com',
    });

    const publicKeyObject = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: vapidKeys.publicKeyBytes.subarray(1, 33).toString('base64url'),
        y: vapidKeys.publicKeyBytes.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const isValidSignature = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
      { key: publicKeyObject, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    );
    expect(isValidSignature).toBe(true);
  });

  it('rejects a non-https push endpoint', () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const vapidKeys = parseVapidKeys(publicKey, privateKey);

    expect(() =>
      buildVapidAuthHeader({
        endpoint: 'http://insecure.push.example/sub',
        subject: 'mailto:yoel@example.com',
        vapidKeys,
      }),
    ).toThrow(/https/iu);
  });
});

describe('encryptWebPushPayload', () => {
  it('encrypts the payload in an RFC 8188 aes128gcm record that decrypts to JSON + 0x02', () => {
    const { subscription, uaEcdh, uaPublic, authSecret } = makeBrowserSubscription();

    const encrypted = encryptWebPushPayload(subscription.keys, SAMPLE_PAYLOAD);
    const { rs, idlen, delimitedPlaintext } = decryptWebPushRecord(
      encrypted,
      uaEcdh,
      uaPublic,
      authSecret,
    );

    expect(rs).toBe(4096);
    expect(idlen).toBe(65);
    expect(delimitedPlaintext[delimitedPlaintext.length - 1]).toBe(0x02);
    const jsonBytes = delimitedPlaintext.subarray(0, delimitedPlaintext.length - 1);
    expect(JSON.parse(jsonBytes.toString('utf8'))).toEqual(SAMPLE_PAYLOAD);
  });

  it('rejects invalid p256dh or auth keys', () => {
    const { subscription } = makeBrowserSubscription();

    expect(() =>
      encryptWebPushPayload(
        { p256dh: randomBytes(32).toString('base64url'), auth: subscription.keys.auth },
        SAMPLE_PAYLOAD,
      ),
    ).toThrow(/p256dh/iu);

    expect(() =>
      encryptWebPushPayload(
        { p256dh: subscription.keys.p256dh, auth: randomBytes(8).toString('base64url') },
        SAMPLE_PAYLOAD,
      ),
    ).toThrow(/auth/iu);
  });
});

describe('WebPushSender.send', () => {
  it('sends an encrypted POST with VAPID headers and returns sent on 201', async () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const { subscription, uaEcdh, uaPublic, authSecret } = makeBrowserSubscription(
      'https://fcm.googleapis.com/fcm/send/device-42',
    );
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 201 })));

    const sender = new WebPushSender({
      publicKey,
      privateKey,
      subject: 'mailto:yoel@example.com',
      fetchFn,
      now: () => new Date('2026-11-09T12:00:00Z'),
    });

    const result = await sender.send(subscription, SAMPLE_PAYLOAD);

    expect(result).toEqual({ status: 'sent' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(subscription.endpoint);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers.ttl).toBe('86400');
    expect(headers.urgency).toBe('normal');
    expect(headers.authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${publicKey}$`, 'u'));

    const bodyBuffer = Buffer.from(init.body as Uint8Array);
    const { delimitedPlaintext } = decryptWebPushRecord(bodyBuffer, uaEcdh, uaPublic, authSecret);
    expect(
      JSON.parse(delimitedPlaintext.subarray(0, delimitedPlaintext.length - 1).toString('utf8')),
    ).toEqual(SAMPLE_PAYLOAD);
  });

  it.each([404, 410])('returns gone when the push service responds with %i', async (status) => {
    const { publicKey, privateKey } = generateVapidKeys();
    const { subscription } = makeBrowserSubscription();
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
    const sender = new WebPushSender({
      publicKey,
      privateKey,
      subject: 'mailto:yoel@example.com',
      fetchFn,
    });

    await expect(sender.send(subscription, SAMPLE_PAYLOAD)).resolves.toEqual({ status: 'gone' });
  });

  it.each([
    [400, 'http_400'],
    [429, 'http_429'],
    [500, 'http_500'],
    [503, 'http_503'],
  ])(
    'returns failed with reason %s when the push service responds with %i',
    async (status, reason) => {
      const { publicKey, privateKey } = generateVapidKeys();
      const { subscription } = makeBrowserSubscription();
      const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
      const sender = new WebPushSender({
        publicKey,
        privateKey,
        subject: 'mailto:yoel@example.com',
        fetchFn,
      });

      await expect(sender.send(subscription, SAMPLE_PAYLOAD)).resolves.toEqual({
        status: 'failed',
        reason,
      });
    },
  );

  it('returns failed with network_error when fetch rejects', async () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const { subscription } = makeBrowserSubscription();
    const fetchFn = vi.fn<typeof fetch>(() => Promise.reject(new Error('socket hang up')));
    const sender = new WebPushSender({
      publicKey,
      privateKey,
      subject: 'mailto:yoel@example.com',
      fetchFn,
    });

    await expect(sender.send(subscription, SAMPLE_PAYLOAD)).resolves.toEqual({
      status: 'failed',
      reason: 'network_error',
    });
  });

  it('returns failed with invalid_subscription without calling fetch when keys are invalid', async () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const fetchFn = vi.fn<typeof fetch>();
    const sender = new WebPushSender({
      publicKey,
      privateKey,
      subject: 'mailto:yoel@example.com',
      fetchFn,
    });

    const badSubscription: PushSubscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub-bad',
      keys: {
        p256dh: 'not-a-valid-p256-point',
        auth: 'not-16-bytes',
      },
    };

    await expect(sender.send(badSubscription, SAMPLE_PAYLOAD)).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_subscription',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('DisabledPushSender & FakePushSender', () => {
  it('DisabledPushSender always resolves failed with reason disabled', async () => {
    const sender: PushSender = new DisabledPushSender();
    const { subscription } = makeBrowserSubscription();

    await expect(sender.send(subscription, SAMPLE_PAYLOAD)).resolves.toEqual({
      status: 'failed',
      reason: 'disabled',
    });
  });

  it('FakePushSender clones calls and returns the configured result', async () => {
    const { subscription } = makeBrowserSubscription();
    const sender = new FakePushSender();

    const result = await sender.send(subscription, SAMPLE_PAYLOAD);
    subscription.keys.auth = 'mutated-after-send';

    expect(result).toEqual({ status: 'sent' });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.subscription.keys.auth).not.toBe('mutated-after-send');
    expect(Buffer.from(FAKE_VAPID_PUBLIC_KEY, 'base64url')).toHaveLength(65);
  });
});
