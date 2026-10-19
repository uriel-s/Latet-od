// Unit tests of the Cookie header parser (cookies.ts). Setting and clearing the session cookie are
// tested through the routes (authRoutes.test.ts), where the Set-Cookie line can be seen whole.
import { describe, expect, it } from 'vitest';
import { readCookie } from './cookies.ts';

describe('readCookie', () => {
  it('reads the only cookie of the header', () => {
    expect(readCookie('session=abc.def', 'session')).toBe('abc.def');
  });

  it('reads the cookie among others, wherever it is', () => {
    expect(readCookie('theme=dark; session=abc.def; lang=he', 'session')).toBe('abc.def');
    expect(readCookie('theme=dark; lang=he; session=abc.def', 'session')).toBe('abc.def');
  });

  it('trims the spaces around names and values', () => {
    expect(readCookie('  theme=dark ;   session =  abc.def  ; lang=he', 'session')).toBe('abc.def');
  });

  it('splits each part at its first "=", so a value may contain "="', () => {
    expect(readCookie('session=abc==.def=', 'session')).toBe('abc==.def=');
  });

  it('takes the first one when the name appears twice', () => {
    expect(readCookie('session=first; session=second', 'session')).toBe('first');
  });

  it('returns an empty value as empty, not as missing', () => {
    expect(readCookie('session=; theme=dark', 'session')).toBe('');
  });

  it('is undefined when the cookie is not there', () => {
    expect(readCookie('theme=dark; lang=he', 'session')).toBeUndefined();
  });

  it('is undefined without a Cookie header, or with an empty one', () => {
    expect(readCookie(undefined, 'session')).toBeUndefined();
    expect(readCookie('', 'session')).toBeUndefined();
  });

  it('matches whole names only, case-sensitively', () => {
    expect(readCookie('xsession=a; sessionx=b; Session=c', 'session')).toBeUndefined();
  });

  it('ignores malformed parts instead of failing', () => {
    expect(readCookie('garbage; ;=nameless; session=abc.def; ;;', 'session')).toBe('abc.def');
    expect(readCookie(';;;', 'session')).toBeUndefined();
  });

  it('returns the value as sent, without URL-decoding it', () => {
    expect(readCookie('session=a%2Eb', 'session')).toBe('a%2Eb');
  });
});
