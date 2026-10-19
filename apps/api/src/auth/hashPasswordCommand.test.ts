// Tests of the hash-password script's logic with fake I/O: what it refuses, what it prints and
// where. The terminal plumbing (hashPasswordCli.ts) is not tested here.
import { LOGIN_PASSWORD_MAX_LENGTH } from '@bottlerun/shared';
import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  runHashPassword,
  stripOneTrailingNewline,
} from './hashPasswordCommand.ts';
import { parsePasswordHash, verifyPassword } from './passwordHash.ts';

/** A test-only password, long enough. */
const PASSWORD = 'סיסמה ארוכה של ארבע מילים';

/** Fake I/O: answers the reads in order and records what was written. */
function fakeIO(answers: string[], interactive: boolean) {
  const remaining = [...answers];
  const io = {
    interactive,
    prompts: [] as string[],
    out: '',
    err: '',
    readPassword: (prompt: string) => {
      io.prompts.push(prompt);
      const answer = remaining.shift();
      if (answer === undefined) throw new Error('the script read more passwords than expected');
      return Promise.resolve(answer);
    },
    writeOut: (text: string) => {
      io.out += text;
    },
    writeErr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

describe('runHashPassword', () => {
  it('prints only the hash line on stdout when a typed password is confirmed', async () => {
    const io = fakeIO([PASSWORD, PASSWORD], true);

    expect(await runHashPassword(io)).toBe(0);

    expect(io.prompts).toHaveLength(2);
    expect(io.out).toMatch(/^scrypt\$[^$\n]+\$[^$\n]+\n$/);
    expect(await verifyPassword(PASSWORD, parsePasswordHash(io.out.trimEnd()))).toBe(true);
    expect(io.err).not.toContain(PASSWORD);
  });

  it('reads a piped password once, without asking again', async () => {
    const io = fakeIO([PASSWORD], false);
    expect(await runHashPassword(io)).toBe(0);
    expect(io.prompts).toHaveLength(1);
    expect(io.out).toMatch(/^scrypt\$/);
  });

  it('refuses when the two typed passwords differ, and prints nothing', async () => {
    const io = fakeIO([PASSWORD, `${PASSWORD}.`], true);
    expect(await runHashPassword(io)).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toMatch(/differ/);
  });

  it(`refuses a password shorter than ${MIN_PASSWORD_LENGTH} characters before asking again`, async () => {
    const io = fakeIO(['x'.repeat(MIN_PASSWORD_LENGTH - 1)], true);
    expect(await runHashPassword(io)).toBe(1);
    expect(io.prompts).toHaveLength(1);
    expect(io.out).toBe('');
    expect(io.err).toMatch(/shorter than 16 characters/);
  });

  it(`refuses a password longer than the login accepts (${LOGIN_PASSWORD_MAX_LENGTH})`, async () => {
    const io = fakeIO(['x'.repeat(LOGIN_PASSWORD_MAX_LENGTH + 1)], false);
    expect(await runHashPassword(io)).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toMatch(/longer than/);
  });

  it.each([
    ['a leading space', ` ${PASSWORD}`],
    ['a trailing space', `${PASSWORD} `],
    ['a line break left from the pipe', `${PASSWORD}\n`],
  ])('refuses a password with %s', async (_label, padded) => {
    const io = fakeIO([padded], false);
    expect(await runHashPassword(io)).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toMatch(/starts or ends/);
  });
});

describe('stripOneTrailingNewline', () => {
  it('removes one \\n or one \\r\\n from the end', () => {
    expect(stripOneTrailingNewline('words here\n')).toBe('words here');
    expect(stripOneTrailingNewline('words here\r\n')).toBe('words here');
  });

  it('removes only one line ending, and nothing else', () => {
    expect(stripOneTrailingNewline('words here\n\n')).toBe('words here\n');
    expect(stripOneTrailingNewline('words here \n')).toBe('words here ');
    expect(stripOneTrailingNewline('words\nhere')).toBe('words\nhere');
    expect(stripOneTrailingNewline('words here')).toBe('words here');
  });
});
