// The collector's session (ADR-0004): a cookie that carries `{ sub, iat, exp }` and an HMAC of it
// with SESSION_SECRET. Nothing is stored server-side, which suits a serverless api; "log out every
// device" means replacing SESSION_SECRET. The session lasts 90 days and renews on use, so Yoel
// never has to log in again mid-round. This module only builds and checks the token; setting the
// cookie and renewing it are the routes' and middleware's job.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sessionPayloadSchema, type SessionPayload, type SessionUser } from '@bottlerun/shared';

/** Name of the session cookie. */
export const SESSION_COOKIE_NAME = 'session';

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

/**
 * How long a session lasts after it is issued: 90 days (ADR-0004). In milliseconds, the unit of
 * a cookie's `maxAge` in Express.
 */
export const SESSION_MAX_AGE_MS = 90 * DAY_MS;

/**
 * A request with a session older than this gets a fresh cookie (ADR-0004: renew after a day). So
 * as long as Yoel opens the app once in 90 days, he is never logged out, while the cookie is
 * rewritten at most once a day, not on every request.
 */
export const SESSION_RENEW_AFTER_MS = DAY_MS;

/** Epoch seconds of `date`, rounded down: the JWT-style unit of `iat` and `exp`. */
function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / SECOND_MS);
}

/** A new session for `user`, issued at `now`, expiring {@link SESSION_MAX_AGE_MS} later. */
export function newSessionPayload(user: SessionUser, now: Date): SessionPayload {
  const iat = epochSeconds(now);
  return { sub: user.sub, iat, exp: iat + SESSION_MAX_AGE_MS / SECOND_MS };
}

/** The signature of a token's first part, base64url: HMAC-SHA256 keyed with the secret. */
function signatureOf(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/**
 * The cookie value for `payload`: `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`, the HMAC
 * taken over the first part as text. Not encrypted: the payload holds nothing secret, only who and
 * when; the signature is what stops anyone from forging or extending it.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signatureOf(encodedPayload, secret)}`;
}

/**
 * The payload of a cookie value made by {@link signSession} with the same `secret`, or null when
 * it cannot be trusted: not two parts, a signature that does not match (forged, tampered, or
 * signed with an old secret), a payload that is not a valid {@link SessionPayload}, or expired
 * (`exp` at or before `now`). Never throws, whatever string it is given: the cookie comes from the
 * client.
 *
 * The signature is compared as text, so only the exact characters signSession wrote pass (Node's
 * base64url decoder would also accept variants with stray characters), and in constant time
 * (`timingSafeEqual`), so response times reveal nothing about the expected signature.
 */
export function verifySession(token: string, secret: string, now: Date): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload = '', signature = ''] = parts;
  if (encodedPayload === '' || signature === '') return null;

  const expected = Buffer.from(signatureOf(encodedPayload, secret), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws on different lengths; the length of a signature is no secret.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = sessionPayloadSchema.safeParse(decoded);
  if (!parsed.success) return null;

  if (parsed.data.exp <= epochSeconds(now)) return null;
  return parsed.data;
}

/**
 * True when the session was issued more than {@link SESSION_RENEW_AFTER_MS} before `now`, so the
 * request should get a fresh cookie (a new payload issued now) and the 90 days start again.
 */
export function needsRenewal(payload: SessionPayload, now: Date): boolean {
  return now.getTime() - payload.iat * SECOND_MS > SESSION_RENEW_AFTER_MS;
}
