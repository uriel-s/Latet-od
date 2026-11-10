// Standards-compliant Web Push sender (ADR-0013) using only Node 24 built-ins (`node:crypto` and
// `fetch`): VAPID authentication (RFC 8292 ES256) and `aes128gcm` payload encryption (RFC 8291 +
// RFC 8188). Zero external dependencies.
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { PushNotificationPayload, PushSubscription } from '@bottlerun/shared';
import type { PushSender, PushSendResult } from './pushSender.ts';

/** Uncompressed P-256 public key length in bytes (`0x04 || X (32B) || Y (32B)`). */
const P256_UNCOMPRESSED_PUBLIC_KEY_BYTES = 65;

/** P-256 private scalar length in bytes. */
const P256_PRIVATE_KEY_BYTES = 32;

/** Web Push `auth` secret length in bytes (RFC 8291 §3.2). */
const WEB_PUSH_AUTH_SECRET_BYTES = 16;

/** Content-encryption salt length in bytes (RFC 8188 §2.1). */
const AES128GCM_SALT_BYTES = 16;

/** RFC 8188 record size (`rs` header field). */
const AES128GCM_RECORD_SIZE = 4096;

/** VAPID JWT lifetime: 12 hours in seconds (RFC 8292 §2 allows up to 24h). */
const VAPID_EXPIRATION_SECONDS = 12 * 60 * 60;

/** Default Push message Time-To-Live in seconds (24 hours). */
const DEFAULT_PUSH_TTL_SECONDS = '86400';

/** Default timeout for pushing to an external push service endpoint (4 seconds). */
const DEFAULT_PUSH_TIMEOUT_MS = 4000;

/** How many stripped leading zero bytes a private key may have (1 in 256 keys loses one, 1 in 65,536 two). */
const MAX_STRIPPED_ZERO_BYTES = 2;

const BASE64URL_ONLY = /^[A-Za-z0-9_-]+$/u;
const BASE64_OR_BASE64URL = /^[A-Za-z0-9+/_-]+={0,2}$/u;

const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'ascii');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'ascii');
const RECORD_DELIMITER = Buffer.from([0x02]);

const JWT_HEADER_BASE64URL = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString(
  'base64url',
);

/** Validated VAPID key pair ready for signing RFC 8292 JWT headers. */
export interface ParsedVapidKeys {
  /** Base64url-encoded 65-byte uncompressed P-256 public key (`k=` parameter). */
  publicKey: string;
  /** Raw 65-byte uncompressed P-256 public key. */
  publicKeyBytes: Buffer;
  /** Node `KeyObject` for `ES256` signing. */
  privateKey: KeyObject;
}

/** Strict base64url decoder that rejects non-base64url characters, padding, or non-canonical bits. */
function decodeStrictBase64Url(value: string): Buffer | null {
  if (!BASE64URL_ONLY.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) return null;
  return decoded;
}

/**
 * Decodes a browser subscription key (`p256dh` or `auth`), accepting canonical base64url or
 * standard base64 (with optional `=` padding) while rejecting malformed characters or trailing bits.
 */
function decodeSubscriptionKey(value: string): Buffer | null {
  if (!BASE64_OR_BASE64URL.test(value)) return null;
  const normalized = value.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  if (!normalized) return null;
  const decoded = Buffer.from(normalized, 'base64url');
  if (decoded.toString('base64url') !== normalized) return null;
  return decoded;
}

/**
 * Generates a fresh P-256 VAPID key pair in base64url format (65-byte uncompressed `publicKey`,
 * 32-byte `privateKey`).
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const rawPrivate = ecdh.getPrivateKey();
  // OpenSSL strips leading 0x00 bytes from BIGNUMs (~1 in 256 keys); left-pad to 32 bytes.
  const privateBytes =
    rawPrivate.length < P256_PRIVATE_KEY_BYTES
      ? Buffer.concat([Buffer.alloc(P256_PRIVATE_KEY_BYTES - rawPrivate.length), rawPrivate])
      : rawPrivate;
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: privateBytes.toString('base64url'),
  };
}

/**
 * Validates a base64url VAPID public/private key pair on P-256 (`prime256v1`) and builds the
 * signing `KeyObject`.
 *
 * - `publicKeyBase64Url` must decode to 65 bytes starting with `0x04`.
 * - `privateKeyBase64Url` must decode to 30-32 bytes (a shorter one is left-padded with zeros:
 *   OpenSSL, and so the `createECDH(...).getPrivateKey()` one-liner in `.env.example`, drops leading
 *   0x00 bytes for ~1 key in 256, and the scalar is the same), be a valid P-256 scalar, and derive
 *   the exact same public key.
 *
 * @throws Error naming `VAPID_PUBLIC_KEY` and/or `VAPID_PRIVATE_KEY` without repeating their values.
 */
export function parseVapidKeys(
  publicKeyBase64Url: string,
  privateKeyBase64Url: string,
): ParsedVapidKeys {
  const pubBytes = decodeStrictBase64Url(publicKeyBase64Url);
  if (!pubBytes || pubBytes.length !== P256_UNCOMPRESSED_PUBLIC_KEY_BYTES || pubBytes[0] !== 0x04) {
    throw new Error(
      'VAPID_PUBLIC_KEY is invalid: it must be a 65-byte uncompressed P-256 public key (starting with 0x04) in base64url.',
    );
  }

  const decodedPrivate = decodeStrictBase64Url(privateKeyBase64Url);
  if (
    !decodedPrivate ||
    decodedPrivate.length < P256_PRIVATE_KEY_BYTES - MAX_STRIPPED_ZERO_BYTES ||
    decodedPrivate.length > P256_PRIVATE_KEY_BYTES
  ) {
    throw new Error(
      'VAPID_PRIVATE_KEY is invalid: it must be a 32-byte P-256 private key in base64url.',
    );
  }
  // Left-pad a key whose leading zero bytes were stripped, so a valid generated key never takes
  // the whole api down at startup.
  const privBytes = Buffer.concat([
    Buffer.alloc(P256_PRIVATE_KEY_BYTES - decodedPrivate.length),
    decodedPrivate,
  ]);

  let derivedPublic: Buffer;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privBytes);
    derivedPublic = ecdh.getPublicKey();
  } catch {
    throw new Error('VAPID_PRIVATE_KEY is invalid: it is not a valid P-256 private scalar.');
  }

  if (!derivedPublic.equals(pubBytes)) {
    throw new Error(
      'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY do not match: the public key does not correspond to the private key.',
    );
  }

  const privateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pubBytes.subarray(1, 33).toString('base64url'),
      y: pubBytes.subarray(33, 65).toString('base64url'),
      d: privBytes.toString('base64url'),
    },
    format: 'jwk',
  });

  return {
    publicKey: publicKeyBase64Url,
    publicKeyBytes: pubBytes,
    privateKey,
  };
}

/**
 * Builds the RFC 8292 VAPID `Authorization` header (`vapid t=<jwt>, k=<publicKey>`) for `endpoint`.
 *
 * @throws Error if `endpoint` is not a valid `https:` URL.
 */
export function buildVapidAuthHeader(params: {
  endpoint: string;
  subject: string;
  vapidKeys: ParsedVapidKeys;
  nowMs?: number;
}): string {
  const endpointUrl = new URL(params.endpoint);
  if (endpointUrl.protocol !== 'https:') {
    throw new Error('Push endpoint must use https.');
  }

  const nowMs = params.nowMs ?? Date.now();
  const payloadBase64Url = Buffer.from(
    JSON.stringify({
      aud: endpointUrl.origin,
      exp: Math.floor(nowMs / 1000) + VAPID_EXPIRATION_SECONDS,
      sub: params.subject,
    }),
  ).toString('base64url');

  const signingInput = `${JWT_HEADER_BASE64URL}.${payloadBase64Url}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: params.vapidKeys.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  return `vapid t=${signingInput}.${signature}, k=${params.vapidKeys.publicKey}`;
}

/**
 * Encrypts `payload` for `subscription.keys` using RFC 8291 (`aes128gcm`) and frames it in a
 * single RFC 8188 record:
 * `salt (16B) || rs (uint32BE = 4096, 4B) || idlen (uint8 = 65, 1B) || asPublic (65B) || ciphertext || tag (16B)`.
 *
 * @throws Error if `subscription.keys.p256dh` is not a valid 65-byte uncompressed P-256 public key
 *   or `subscription.keys.auth` is not a 16-byte secret.
 */
export function encryptWebPushPayload(
  subscriptionKeys: PushSubscription['keys'],
  payload: PushNotificationPayload,
): Buffer {
  const uaPublic = decodeSubscriptionKey(subscriptionKeys.p256dh);
  if (!uaPublic || uaPublic.length !== P256_UNCOMPRESSED_PUBLIC_KEY_BYTES || uaPublic[0] !== 0x04) {
    throw new Error('Invalid subscription p256dh key.');
  }

  const authSecret = decodeSubscriptionKey(subscriptionKeys.auth);
  if (!authSecret || authSecret.length !== WEB_PUSH_AUTH_SECRET_BYTES) {
    throw new Error('Invalid subscription auth secret.');
  }

  const asEcdh = createECDH('prime256v1');
  const asPublic = asEcdh.generateKeys();
  // computeSecret validates that uaPublic lies on the P-256 curve and is not the point at infinity.
  const sharedSecret = asEcdh.computeSecret(uaPublic);

  const salt = randomBytes(AES128GCM_SALT_BYTES);
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, 12));

  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload), 'utf8'), RECORD_DELIMITER]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const header = Buffer.alloc(AES128GCM_SALT_BYTES + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(AES128GCM_RECORD_SIZE, AES128GCM_SALT_BYTES);
  header.writeUInt8(asPublic.length, AES128GCM_SALT_BYTES + 4);
  asPublic.copy(header, AES128GCM_SALT_BYTES + 5);

  return Buffer.concat([header, ciphertext, authTag]);
}

/** Configuration for {@link WebPushSender}. */
export interface WebPushSenderOptions {
  /** Base64url-encoded 65-byte uncompressed P-256 public key (`VAPID_PUBLIC_KEY`). */
  publicKey: string;
  /** Base64url-encoded 32-byte P-256 private scalar (`VAPID_PRIVATE_KEY`). */
  privateKey: string;
  /** Contact URI (`mailto:...` or `https://...`, `VAPID_SUBJECT`). */
  subject: string;
  /** Custom `fetch` implementation for tests; defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Clock for JWT `exp` calculation in tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Request timeout in milliseconds; defaults to 4000. */
  timeoutMs?: number;
}

/**
 * Production {@link PushSender} (ADR-0013): encrypts the notification payload with `aes128gcm`
 * (RFC 8291), signs a VAPID `ES256` JWT (RFC 8292), and `POST`s the encrypted record to the
 * subscription's push service endpoint.
 */
export class WebPushSender implements PushSender {
  private readonly vapidKeys: ParsedVapidKeys;
  private readonly subject: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: WebPushSenderOptions) {
    this.vapidKeys = parseVapidKeys(options.publicKey, options.privateKey);
    this.subject = options.subject;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  }

  async send(
    subscription: PushSubscription,
    payload: PushNotificationPayload,
  ): Promise<PushSendResult> {
    let body: Buffer;
    let authorization: string;
    try {
      authorization = buildVapidAuthHeader({
        endpoint: subscription.endpoint,
        subject: this.subject,
        vapidKeys: this.vapidKeys,
        nowMs: this.now().getTime(),
      });
      body = encryptWebPushPayload(subscription.keys, payload);
    } catch {
      return { status: 'failed', reason: 'invalid_subscription' };
    }

    let response: Response;
    try {
      response = await this.fetchFn(subscription.endpoint, {
        method: 'POST',
        headers: {
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: DEFAULT_PUSH_TTL_SECONDS,
          urgency: 'normal',
          authorization,
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { status: 'failed', reason: 'network_error' };
    }

    if (response.ok) {
      return { status: 'sent' };
    }
    if (response.status === 404 || response.status === 410) {
      return { status: 'gone' };
    }
    return { status: 'failed', reason: `http_${response.status}` };
  }
}
