// Tests of the signed session token (ADR-0004): round trip, forgery and tampering, expiry, and
// when a session is due for renewal. Pure functions: the clock is passed in.
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SESSION_MAX_AGE_MS,
  SESSION_RENEW_AFTER_MS,
  needsRenewal,
  newSessionPayload,
  signSession,
  verifySession,
} from './session.ts';

/** Test-only secrets, random per run. */
const SECRET = randomBytes(32).toString('base64url');
const OTHER_SECRET = randomBytes(32).toString('base64url');

/** A whole second, so `iat` equals it exactly. */
const ISSUED_AT = new Date('2026-10-20T09:00:00.000Z');
const ISSUED_AT_S = ISSUED_AT.getTime() / 1000;
const DAY_S = 24 * 60 * 60;

const payload = newSessionPayload({ sub: 'collector' }, ISSUED_AT);
const token = signSession(payload, SECRET);

/** `date` moved by `ms` milliseconds. */
function later(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/** base64url of `value` as JSON: a token's first part. */
function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * A token whose first part is `encodedPayload`, signed the way ADR-0004 defines it: HMAC-SHA256
 * with SECRET over the first part as text. Signs payloads signSession never would (not JSON, the
 * wrong shape), and pins the format independently of the implementation.
 */
function signRaw(encodedPayload: string): string {
  const signature = createHmac('sha256', SECRET).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

describe('newSessionPayload', () => {
  it('issues a collector session now, expiring in 90 days, in epoch seconds', () => {
    expect(payload).toEqual({ sub: 'collector', iat: ISSUED_AT_S, exp: ISSUED_AT_S + 90 * DAY_S });
    expect(SESSION_MAX_AGE_MS).toBe(90 * DAY_S * 1000);
  });

  it('rounds a time inside a second down', () => {
    expect(newSessionPayload({ sub: 'collector' }, later(ISSUED_AT, 999)).iat).toBe(ISSUED_AT_S);
  });
});

describe('signSession', () => {
  it('writes base64url(JSON payload), a dot, and base64url(HMAC-SHA256 of the first part)', () => {
    expect(token).toBe(signRaw(encodeJson(payload)));
  });
});

describe('verifySession', () => {
  it('gives back the payload of a token signSession signed', () => {
    expect(verifySession(token, SECRET, ISSUED_AT)).toEqual(payload);
  });

  it('still accepts the token one second before it expires', () => {
    const lastSecond = later(ISSUED_AT, SESSION_MAX_AGE_MS - 1000);
    expect(verifySession(token, SECRET, lastSecond)).toEqual(payload);
  });

  it('rejects a token at the second it expires', () => {
    expect(verifySession(token, SECRET, later(ISSUED_AT, SESSION_MAX_AGE_MS))).toBeNull();
  });

  it('rejects a token after it expired', () => {
    const afterExpiry = later(ISSUED_AT, SESSION_MAX_AGE_MS + DAY_S * 1000);
    expect(verifySession(token, SECRET, afterExpiry)).toBeNull();
  });

  it('rejects a token signed with another secret (e.g. after SESSION_SECRET was replaced)', () => {
    expect(verifySession(signSession(payload, OTHER_SECRET), SECRET, ISSUED_AT)).toBeNull();
  });

  it('rejects a payload changed after signing (a later expiry)', () => {
    const [, signature] = token.split('.');
    const extended = encodeJson({ ...payload, exp: payload.exp + 365 * DAY_S });
    expect(verifySession(`${extended}.${signature}`, SECRET, ISSUED_AT)).toBeNull();
  });

  it('rejects a changed signature', () => {
    const otherLastChar = token.endsWith('A') ? 'B' : 'A';
    expect(verifySession(`${token.slice(0, -1)}${otherLastChar}`, SECRET, ISSUED_AT)).toBeNull();
  });

  it('rejects a signature with a stray character that base64url decoding would skip', () => {
    expect(verifySession(`${token}*`, SECRET, ISSUED_AT)).toBeNull();
    expect(verifySession(`${token}=`, SECRET, ISSUED_AT)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a lone dot', '.'],
    ['short garbage', 'a.b'],
    ['no dot', 'abcdef'],
    ['three parts', `${token}.extra`],
    ['an empty signature', `${encodeJson(payload)}.`],
    ['an empty payload', `.${token.split('.')[1] ?? ''}`],
    ['non-ASCII text', 'סשן.חתימה'],
  ])('rejects %s without throwing', (_label, garbage) => {
    expect(verifySession(garbage, SECRET, ISSUED_AT)).toBeNull();
  });

  it('rejects a correctly signed payload that is not JSON', () => {
    const notJson = Buffer.from('not json', 'utf8').toString('base64url');
    expect(verifySession(signRaw(notJson), SECRET, ISSUED_AT)).toBeNull();
  });

  it.each([
    ['another subject', { sub: 'admin', iat: ISSUED_AT_S, exp: ISSUED_AT_S + DAY_S }],
    ['no expiry', { sub: 'collector', iat: ISSUED_AT_S }],
    [
      'times as strings',
      { sub: 'collector', iat: `${ISSUED_AT_S}`, exp: `${ISSUED_AT_S + DAY_S}` },
    ],
    ['an array', ['collector', ISSUED_AT_S, ISSUED_AT_S + DAY_S]],
    ['null', null],
  ])('rejects a correctly signed payload with %s', (_label, wrongShape) => {
    expect(verifySession(signRaw(encodeJson(wrongShape)), SECRET, ISSUED_AT)).toBeNull();
  });
});

describe('needsRenewal', () => {
  it('is false for a session issued an hour ago', () => {
    expect(needsRenewal(payload, later(ISSUED_AT, 60 * 60 * 1000))).toBe(false);
  });

  it('is false at exactly one day', () => {
    expect(needsRenewal(payload, later(ISSUED_AT, SESSION_RENEW_AFTER_MS))).toBe(false);
  });

  it('is true just after one day', () => {
    expect(needsRenewal(payload, later(ISSUED_AT, SESSION_RENEW_AFTER_MS + 1))).toBe(true);
  });
});
