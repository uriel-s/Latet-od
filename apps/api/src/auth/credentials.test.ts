// Tests of the single-password login check (ADR-0004), against a hash made in the test.
import { beforeAll, describe, expect, it } from 'vitest';
import { createVerifyCredentials, type VerifyCredentials } from './credentials.ts';
import { hashPassword } from './passwordHash.ts';

/** A test-only password. */
const PASSWORD = 'four long words for yoel';

let verifyCredentials: VerifyCredentials;

beforeAll(async () => {
  verifyCredentials = createVerifyCredentials(await hashPassword(PASSWORD));
});

describe('createVerifyCredentials', () => {
  it('logs the right password in as the collector', async () => {
    expect(await verifyCredentials(PASSWORD)).toEqual({ sub: 'collector' });
  });

  it('answers null for a wrong password', async () => {
    expect(await verifyCredentials('four long words for joel')).toBeNull();
  });

  it('answers null for the right password with a different case', async () => {
    expect(await verifyCredentials(PASSWORD.toUpperCase())).toBeNull();
  });

  it('throws at creation for a malformed hash, without echoing it', () => {
    const malformed = 'scrypt$not-a-salt$not-a-hash';
    let message = '';
    try {
      createVerifyCredentials(malformed);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^Malformed password hash/);
    expect(message).not.toContain('not-a-');
  });
});
