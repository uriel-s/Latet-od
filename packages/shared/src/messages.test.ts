import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index.ts';
import {
  messageLinkSchema,
  messageOpenedResponseSchema,
  pickupTimeSchema,
  renderMessage,
  toMessageLink,
  type MessageVars,
} from './messages.ts';
import type { MessageLogEntry, Order } from './order.ts';

const LINK = 'https://bottlerun.example/o/Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv';
const AT = new Date('2026-11-04T17:00:00.000Z');
const OPENED_AT = new Date('2026-11-04T17:05:00.000Z');

/** The vars of a confirmation request for the round of 5 November. */
function makeVars(overrides: Partial<MessageVars> = {}): MessageVars {
  return { name: 'משה כהן', link: LINK, date: '2026-11-05', ...overrides };
}

/** A manual (wa.me) log entry of the given kind. */
function manualEntry(kind: MessageLogEntry['kind'], url: string, openedAt?: Date): MessageLogEntry {
  return { kind, at: AT, mode: 'manual', url, ...(openedAt === undefined ? {} : { openedAt }) };
}

/** A stored order in a round, with the given message log. */
function makeOrder(messages: MessageLogEntry[]): Order {
  return {
    id: '6710f3a2c4b5d6e7f8a9b0c1',
    contact: { name: 'משה כהן', phone: '+972501234567', method: 'whatsapp' },
    address: { streetName: 'רחוב חדש', houseNumber: '5', bottlesSpot: 'privateHouse' },
    bottlesEstimated: 45,
    status: 'pending',
    token: 'Qm9ZtL3x_8Vb-1kHw2Rj5NpA7cYeG0sUoDfIiKqTnWv',
    roundId: 'round-1',
    messages,
    source: 'form',
    createdAt: AT,
    updatedAt: AT,
  };
}

/** The error `action` throws, or a failed test if it does not throw. */
function errorOf(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('threw something that is not an Error', { cause: error });
  }
  throw new Error('expected a throw');
}

describe('renderMessage', () => {
  describe('confirmRequest', () => {
    it('writes name, date, link and sign-off, line by line', () => {
      expect(renderMessage('confirmRequest', makeVars())).toBe(
        [
          'שלום משה כהן,',
          'ב-05/11 נעבור לאסוף את הבקבוקים שלכם.',
          'נא לאשר את האיסוף בקישור:',
          LINK,
          'תודה, לתת עוד',
        ].join('\n'),
      );
    });

    it('adds the pickup time and the personal text, in that order, before the link', () => {
      const text = renderMessage(
        'confirmRequest',
        makeVars({ pickupBy: '08:30' }),
        'השבוע נגיע מוקדם.\nתודה על הסבלנות',
      );
      expect(text).toBe(
        [
          'שלום משה כהן,',
          'ב-05/11 נעבור לאסוף את הבקבוקים שלכם.',
          'נא להוציא את הבקבוקים עד השעה 08:30.',
          'השבוע נגיע מוקדם.',
          'תודה על הסבלנות',
          'נא לאשר את האיסוף בקישור:',
          LINK,
          'תודה, לתת עוד',
        ].join('\n'),
      );
    });

    it('adds the personal text without a pickup time', () => {
      const text = renderMessage('confirmRequest', makeVars(), 'נא לא לשים בשקית');
      expect(text.split('\n')).toEqual([
        'שלום משה כהן,',
        'ב-05/11 נעבור לאסוף את הבקבוקים שלכם.',
        'נא לא לשים בשקית',
        'נא לאשר את האיסוף בקישור:',
        LINK,
        'תודה, לתת עוד',
      ]);
    });

    it('adds the pickup time without a personal text', () => {
      const text = renderMessage('confirmRequest', makeVars({ pickupBy: '18:00' }));
      expect(text.split('\n')).toContain('נא להוציא את הבקבוקים עד השעה 18:00.');
      expect(text.split('\n')).toHaveLength(6);
    });

    it('shows the round date as DD/MM', () => {
      expect(renderMessage('confirmRequest', makeVars({ date: '2027-01-09' }))).toContain(
        'ב-09/01 ',
      );
    });

    it('trims the name and the personal text', () => {
      const text = renderMessage('confirmRequest', makeVars({ name: '  משה  ' }), '\n  להתראות \n');
      expect(text.split('\n')[0]).toBe('שלום משה,');
      expect(text.split('\n')).toContain('להתראות');
    });

    it('leaves out a personal text that is empty or only spaces', () => {
      const withoutText = renderMessage('confirmRequest', makeVars());
      for (const blank of ['', '   ', '\n\t \n']) {
        expect(renderMessage('confirmRequest', makeVars(), blank), JSON.stringify(blank)).toBe(
          withoutText,
        );
      }
    });

    it('signs off with the app name', () => {
      expect(renderMessage('confirmRequest', makeVars()).endsWith(`\nתודה, ${APP_NAME}`)).toBe(
        true,
      );
    });

    it('throws a RangeError without a date', () => {
      expect(() => renderMessage('confirmRequest', makeVars({ date: undefined }))).toThrow(
        RangeError,
      );
    });

    it('throws a RangeError for a malformed date, without the value in the message', () => {
      const error = errorOf(() =>
        renderMessage('confirmRequest', makeVars({ date: '05/11/2026' })),
      );
      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).not.toContain('05/11/2026');
    });

    it('throws a RangeError for a malformed pickup time, without the value in the message', () => {
      for (const pickupBy of ['8:30', '24:00', '18:00:00', '']) {
        const error = errorOf(() => renderMessage('confirmRequest', makeVars({ pickupBy })));
        expect(error, pickupBy).toBeInstanceOf(RangeError);
        if (pickupBy !== '') expect(error.message, pickupBy).not.toContain(pickupBy);
      }
    });
  });

  describe('thankYou', () => {
    it('thanks with the spec wording and links to the order page for ordering again', () => {
      expect(renderMessage('thankYou', { name: 'משה כהן', link: LINK })).toBe(
        [
          'שלום משה כהן,',
          'הזמנתכם נאספה! תודה רבה שלקחתם חלק בלתת עוד!',
          'להזמנה חוזרת:',
          LINK,
        ].join('\n'),
      );
    });

    it('ignores the date, the pickup time and the personal text', () => {
      const plain = renderMessage('thankYou', { name: 'משה כהן', link: LINK });
      const withExtras = renderMessage(
        'thankYou',
        makeVars({ pickupBy: '08:30' }),
        'טקסט אישי לסבב',
      );
      expect(withExtras).toBe(plain);
    });

    it('does not need a date, and does not check one', () => {
      expect(() =>
        renderMessage('thankYou', makeVars({ date: 'not a date', pickupBy: 'later' })),
      ).not.toThrow();
    });

    it('trims the name', () => {
      expect(renderMessage('thankYou', { name: ' משה ', link: LINK })).toMatch(/^שלום משה,\n/);
    });
  });
});

describe('pickupTimeSchema', () => {
  it('accepts HH:MM from 00:00 to 23:59', () => {
    for (const time of ['00:00', '08:00', '12:30', '19:45', '23:59']) {
      expect(pickupTimeSchema.safeParse(time).success, time).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const time of ['8:00', '24:00', '12:60', '0800', '08:00 ', '08:00:00', '', '8']) {
      expect(pickupTimeSchema.safeParse(time).success, time).toBe(false);
    }
  });
});

describe('toMessageLink', () => {
  it('returns the latest manual entry of the kind, with its index and the customer name', () => {
    const order = makeOrder([
      manualEntry('confirmRequest', 'https://wa.me/972501234567?text=old'),
      manualEntry('confirmRequest', 'https://wa.me/972501234567?text=new'),
    ]);
    expect(toMessageLink(order, 'confirmRequest')).toEqual({
      orderId: '6710f3a2c4b5d6e7f8a9b0c1',
      messageIndex: 1,
      kind: 'confirmRequest',
      name: 'משה כהן',
      url: 'https://wa.me/972501234567?text=new',
    });
  });

  it('skips entries of the other kind', () => {
    const order = makeOrder([
      manualEntry('confirmRequest', 'https://wa.me/972501234567?text=confirm'),
      manualEntry('thankYou', 'https://wa.me/972501234567?text=thanks'),
      { kind: 'thankYou', at: AT, mode: 'failed', reason: 'timeout' },
    ]);
    expect(toMessageLink(order, 'confirmRequest')).toMatchObject({
      messageIndex: 0,
      url: 'https://wa.me/972501234567?text=confirm',
    });
  });

  // An older manual link belongs to an earlier round (another date): sending it would be wrong.
  it('returns undefined when a newer sent or failed entry of the kind follows a manual one', () => {
    const thenSent = makeOrder([
      manualEntry('confirmRequest', 'https://wa.me/972501234567?text=old-round'),
      { kind: 'confirmRequest', at: AT, mode: 'sent', providerId: 'wamid.1' },
    ]);
    expect(toMessageLink(thenSent, 'confirmRequest')).toBeUndefined();
    const thenFailed = makeOrder([
      manualEntry('confirmRequest', 'https://wa.me/972501234567?text=old-round'),
      { kind: 'confirmRequest', at: AT, mode: 'failed', reason: 'timeout' },
      manualEntry('thankYou', 'https://wa.me/972501234567?text=thanks'),
    ]);
    expect(toMessageLink(thenFailed, 'confirmRequest')).toBeUndefined();
    expect(toMessageLink(thenFailed, 'thankYou')).toMatchObject({
      messageIndex: 2,
      kind: 'thankYou',
    });
  });

  it('returns undefined when the order has no manual entry of the kind', () => {
    expect(toMessageLink(makeOrder([]), 'confirmRequest')).toBeUndefined();
    const order = makeOrder([
      { kind: 'thankYou', at: AT, mode: 'sent', providerId: 'wamid.1' },
      manualEntry('confirmRequest', 'https://wa.me/972501234567?text=confirm'),
    ]);
    expect(toMessageLink(order, 'thankYou')).toBeUndefined();
  });

  it('carries openedAt when the link was opened, and leaves it out when not', () => {
    const opened = makeOrder([manualEntry('thankYou', 'https://wa.me/1', OPENED_AT)]);
    expect(toMessageLink(opened, 'thankYou')?.openedAt).toEqual(OPENED_AT);
    const notOpened = makeOrder([manualEntry('thankYou', 'https://wa.me/1')]);
    expect(toMessageLink(notOpened, 'thankYou')).not.toHaveProperty('openedAt');
  });

  it('builds a row that messageLinkSchema accepts', () => {
    const order = makeOrder([manualEntry('confirmRequest', 'https://wa.me/1', OPENED_AT)]);
    const link = toMessageLink(order, 'confirmRequest');
    expect(messageLinkSchema.parse(link)).toEqual(link);
  });
});

describe('messageLinkSchema', () => {
  const row = {
    orderId: '6710f3a2c4b5d6e7f8a9b0c1',
    messageIndex: 2,
    kind: 'confirmRequest',
    name: 'משה כהן',
    url: 'https://wa.me/972501234567?text=x',
  };

  it('parses a row, and the ISO openedAt of an api response into a Date', () => {
    expect(messageLinkSchema.parse(row)).toEqual(row);
    const parsed = messageLinkSchema.parse({ ...row, openedAt: '2026-11-04T17:05:00.000Z' });
    expect(parsed.openedAt).toEqual(OPENED_AT);
  });

  it('rejects a url that is not https', () => {
    for (const url of ['http://wa.me/972501234567', 'javascript:alert(1)', 'wa.me/972501234567']) {
      expect(messageLinkSchema.safeParse({ ...row, url }).success, url).toBe(false);
    }
  });

  it('rejects a negative or fractional index and an empty name', () => {
    expect(messageLinkSchema.safeParse({ ...row, messageIndex: -1 }).success).toBe(false);
    expect(messageLinkSchema.safeParse({ ...row, messageIndex: 1.5 }).success).toBe(false);
    expect(messageLinkSchema.safeParse({ ...row, name: '' }).success).toBe(false);
  });
});

describe('messageOpenedResponseSchema', () => {
  it('parses the ISO string of the api response into a Date', () => {
    expect(messageOpenedResponseSchema.parse({ openedAt: '2026-11-04T17:05:00.000Z' })).toEqual({
      openedAt: OPENED_AT,
    });
  });

  it('rejects a body without a valid openedAt', () => {
    expect(messageOpenedResponseSchema.safeParse({}).success).toBe(false);
    expect(messageOpenedResponseSchema.safeParse({ openedAt: 'yesterday' }).success).toBe(false);
  });
});
