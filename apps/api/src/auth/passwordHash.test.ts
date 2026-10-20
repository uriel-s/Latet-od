// Tests of the scrypt password hash (ADR-0004). Each hash or check runs scrypt (about 50 ms), so
// one hash made in beforeAll serves most tests.
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, parsePasswordHash, verifyPassword } from './passwordHash.ts';

/** A test-only password, the shape of the real one: a sentence of four words or more. */
const PASSWORD = 'בקבוקים ירוקים עוזרים לתפילין';

/** 22 base64url characters: 16 bytes of salt. 86: 64 bytes of hash. */
const STORED_FORMAT = /^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;

let stored: string;

beforeAll(async () => {
  stored = await hashPassword(PASSWORD);
});

/** `stored` with one of its three `$` parts replaced. */
function withPart(index: number, replacement: string): string {
  const parts = stored.split('$');
  parts[index] = replacement;
  return parts.join('$');
}

describe('hashPassword', () => {
  it('returns scrypt$<salt>$<hash> in base64url without padding', () => {
    expect(stored).toMatch(STORED_FORMAT);
  });

  it('gives the same password a different hash each time (random salt)', async () => {
    const again = await hashPassword(PASSWORD);
    expect(again).toMatch(STORED_FORMAT);
    expect(again).not.toBe(stored);
    expect(again.split('$')[1]).not.toBe(stored.split('$')[1]);
  });
});

describe('verifyPassword', () => {
  it('accepts the password the hash was made from', async () => {
    expect(await verifyPassword(PASSWORD, parsePasswordHash(stored))).toBe(true);
  });

  it('rejects a wrong password', async () => {
    expect(await verifyPassword(`${PASSWORD}!`, parsePasswordHash(stored))).toBe(false);
  });
});

describe('parsePasswordHash', () => {
  it('splits a stored hash into a 16-byte salt and a 64-byte hash', () => {
    const { salt, hash } = parsePasswordHash(stored);
    expect(salt).toHaveLength(16);
    expect(hash).toHaveLength(64);
  });

  // Each malformed value contains this marker, standing in for the secret: no error may show it.
  const SECRET_MARKER = 'SeCrEtMaRkEr';

  it.each([
    ['an empty string', () => ''],
    ['a password instead of a hash', () => SECRET_MARKER],
    ['two parts', () => `scrypt$${SECRET_MARKER}`],
    ['four parts', () => `${stored}$${SECRET_MARKER}`],
    ['another scheme', () => withPart(0, `bcrypt${SECRET_MARKER}`)],
    ['a salt that is not base64url', () => withPart(1, `${SECRET_MARKER}!!!!!!!!!!`)],
    ['a salt of the wrong length', () => withPart(1, SECRET_MARKER)],
    ['a padded salt', () => withPart(1, `${stored.split('$')[1] ?? ''}==`)],
    ['a hash of the wrong length', () => withPart(2, SECRET_MARKER)],
    ['a hash with a stray character', () => withPart(2, `${stored.split('$')[2] ?? ''}*`)],
  ])('rejects %s without echoing the value', (_label, makeValue) => {
    const value = makeValue();
    let thrown: unknown;
    try {
      parsePasswordHash(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/^Malformed password hash/);
    expect(message).not.toContain(SECRET_MARKER);
    if (value !== '') expect(message).not.toContain(value);
  });
});
