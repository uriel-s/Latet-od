// Tests of the wa.me sender (ADR-0003): the phone in wa.me's form (972, no 0, no +), the strict
// percent-encoding of the text (Hebrew, spaces, line breaks), and that WaMeLinkSender.send gives
// a link whose text is exactly renderMessage's, in a shape the order's message log accepts.
import {
  messageLogEntrySchema,
  renderMessage,
  type OutgoingMessage,
  type MessageKind,
} from '@bottlerun/shared';
import { describe, expect, it } from 'vitest';
import type { SendResult } from './messageSender.ts';
import { WaMeLinkSender, encodeWaMeText, waMePhone, waMeUrl } from './waMeLinkSender.ts';

const PHONE = '+972501234567';
const LINK = 'https://latet-od.example/o/Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';

/** Text with everything that must not stay raw in a link: Hebrew, spaces, a line break, `+!()*'`. */
const TRICKY_TEXT = "שלום משה,\nנא לאשר (בבקשה)! 1+1 = 2 * 'ok'";

/** Characters RFC 3986 lets stand unencoded in a query value, plus `%` of the escapes. */
const STRICTLY_ENCODED = /^[A-Za-z0-9\-_.~%]*$/;

/** A confirmation request to {@link PHONE} for the round of 5 November, with overrides on top. */
function makeMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    kind: 'confirmRequest',
    orderId: '6710f3a2c4b5d6e7f8a9b0c1',
    to: PHONE,
    vars: { name: 'משה כהן', link: LINK, date: '2026-11-05', pickupBy: '08:00' },
    personalText: 'נא לשים בשקית (לא בקרטון)!',
    ...overrides,
  };
}

/** The part of a wa.me url after `?text=`, still encoded. */
function encodedTextOf(url: string): string {
  const marker = '?text=';
  const at = url.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  return url.slice(at + marker.length);
}

/** The url of a `manual` result; fails the test for any other mode. */
function manualUrl(result: SendResult): string {
  if (result.mode !== 'manual') throw new Error(`expected a manual result, got ${result.mode}`);
  return result.url;
}

describe('waMePhone', () => {
  it('drops the + of an E.164 Israeli mobile', () => {
    expect(waMePhone(PHONE)).toBe('972501234567');
  });

  it.each([
    ['a local number', '0501234567'],
    ['972 without the +', '972501234567'],
    ['a landline', '+97221234567'],
    ['the trunk 0 after the country code', '+9720501234567'],
    ['an empty string', ''],
  ])('refuses %s', (_label, phone) => {
    expect(waMePhone(phone)).toBeNull();
  });
});

describe('encodeWaMeText', () => {
  it('encodes a space as %20 and a line break as %0A', () => {
    expect(encodeWaMeText('a b\nc')).toBe('a%20b%0Ac');
  });

  it('encodes Hebrew as its UTF-8 bytes', () => {
    expect(encodeWaMeText('ש')).toBe('%D7%A9');
  });

  it("encodes the !'()* that encodeURIComponent leaves raw, and +", () => {
    expect(encodeWaMeText("!'()*+")).toBe('%21%27%28%29%2A%2B');
  });

  it('leaves only unreserved characters raw, and decodes back to the exact text', () => {
    const encoded = encodeWaMeText(TRICKY_TEXT);

    expect(encoded).toMatch(STRICTLY_ENCODED);
    expect(decodeURIComponent(encoded)).toBe(TRICKY_TEXT);
  });

  it('keeps an emoji whole', () => {
    expect(decodeURIComponent(encodeWaMeText('תודה 👍'))).toBe('תודה 👍');
  });

  it('turns a lone surrogate into U+FFFD instead of throwing', () => {
    const halfAnEmoji = 'משה' + String.fromCharCode(0xd83d);

    expect(encodeWaMeText(halfAnEmoji)).toBe(`${encodeWaMeText('משה')}%EF%BF%BD`);
  });
});

describe('waMeUrl', () => {
  it('opens a chat with the number in wa.me form', () => {
    expect(waMeUrl(PHONE, 'שלום')).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/);
  });

  it('puts the text in strictly encoded, so it decodes back exactly', () => {
    const text = encodedTextOf(waMeUrl(PHONE, TRICKY_TEXT) ?? '');

    expect(text).not.toMatch(/\p{Script=Hebrew}/u);
    for (const raw of [' ', '\n', '+', '!', '(', ')']) {
      expect(text).not.toContain(raw);
    }
    expect(text).toMatch(STRICTLY_ENCODED);
    expect(decodeURIComponent(text)).toBe(TRICKY_TEXT);
  });

  it('encodes a space as %20, never +', () => {
    expect(waMeUrl(PHONE, 'a b')).toBe('https://wa.me/972501234567?text=a%20b');
  });

  it('is null for a phone that is not E.164 mobile', () => {
    expect(waMeUrl('0501234567', 'שלום')).toBeNull();
  });
});

describe('WaMeLinkSender', () => {
  it('turns a confirmation request into a wa.me link with the rendered text', async () => {
    const message = makeMessage();

    const url = manualUrl(await new WaMeLinkSender().send(message));

    expect(url).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/);
    const text = decodeURIComponent(encodedTextOf(url));
    expect(text).toBe(renderMessage(message.kind, message.vars, message.personalText));
    expect(text).toContain(LINK);
    expect(text).toContain('05/11');
    expect(text).toContain('נא לשים בשקית (לא בקרטון)!');
  });

  it('turns a thank-you into a wa.me link with the rendered text', async () => {
    const message = makeMessage({ kind: 'thankYou', vars: { name: 'משה כהן', link: LINK } });

    const url = manualUrl(await new WaMeLinkSender().send(message));

    expect(decodeURIComponent(encodedTextOf(url))).toBe(renderMessage('thankYou', message.vars));
  });

  it.each<MessageKind>(['confirmRequest', 'thankYou'])(
    'gives a url the message log accepts (%s)',
    async (kind) => {
      const result = await new WaMeLinkSender().send(makeMessage({ kind }));

      const entry = messageLogEntrySchema.safeParse({ kind, at: new Date(), ...result });
      expect(entry.success).toBe(true);
      expect(entry.data?.mode).toBe('manual');
    },
  );

  it.each([
    ['a local number', '0501234567'],
    ['a landline', '+97221234567'],
    ['an empty string', ''],
  ])('fails with invalid_phone for %s, without the number', async (_label, to) => {
    const result = await new WaMeLinkSender().send(makeMessage({ to }));

    expect(result).toEqual({ mode: 'failed', reason: 'invalid_phone' });
  });

  it('fails on the phone before rendering, so a bad phone never rejects', async () => {
    const noDate = makeMessage({ to: '0501234567', vars: { name: 'משה כהן', link: LINK } });

    await expect(new WaMeLinkSender().send(noDate)).resolves.toEqual({
      mode: 'failed',
      reason: 'invalid_phone',
    });
  });

  it('rejects a confirmation request it cannot render (no date): a bug, not a failure', async () => {
    const noDate = makeMessage({ vars: { name: 'משה כהן', link: LINK } });

    await expect(new WaMeLinkSender().send(noDate)).rejects.toThrow(RangeError);
  });
});
