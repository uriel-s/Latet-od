import { describe, expect, it } from 'vitest';
import { pickupTimeSchema } from './dates.ts';
import { t, type Lang } from './i18n.ts';
import { APP_NAME } from './index.ts';
import {
  messageLinkSchema,
  messageOpenedResponseSchema,
  renderMessage,
  toMessageLink,
  type MessageVars,
} from './messages.ts';
import type { MessageKind, MessageLogEntry, Order } from './order.ts';

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
    lang: 'he',
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

    it('words the pickup time as a window when pickupFrom is given', () => {
      const text = renderMessage(
        'confirmRequest',
        makeVars({ pickupFrom: '07:00', pickupBy: '08:30' }),
      );
      expect(text.split('\n')).toContain('נא להוציא את הבקבוקים בין השעות 07:00 ל-08:30.');
      expect(text).not.toContain('עד השעה');
    });

    it('throws a RangeError for a malformed pickupFrom or one without pickupBy, without the value', () => {
      for (const pickupFrom of ['7:00', '24:00', '']) {
        const error = errorOf(() =>
          renderMessage('confirmRequest', makeVars({ pickupFrom, pickupBy: '08:30' })),
        );
        expect(error, pickupFrom).toBeInstanceOf(RangeError);
        if (pickupFrom !== '') expect(error.message, pickupFrom).not.toContain(pickupFrom);
      }
      const lone = errorOf(() =>
        renderMessage('confirmRequest', makeVars({ pickupFrom: '07:00' })),
      );
      expect(lone).toBeInstanceOf(RangeError);
      expect(lone.message).not.toContain('07:00');
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

  describe('language', () => {
    it.each<MessageKind>(['confirmRequest', 'thankYou'])(
      'gives exactly the default (Hebrew) text for an explicit he (%s)',
      (kind) => {
        const vars = makeVars({ pickupFrom: '07:00', pickupBy: '08:30' });
        expect(renderMessage(kind, vars, 'טקסט אישי', 'he')).toBe(
          renderMessage(kind, vars, 'טקסט אישי'),
        );
      },
    );

    it.each<Lang>(['he', 'en'])(
      'signs the confirmation request off with the app name (%s)',
      (lang) => {
        expect(t(lang, 'whatsapp.confirmRequest.signOff').endsWith(APP_NAME)).toBe(true);
        expect(
          renderMessage('confirmRequest', makeVars(), undefined, lang).endsWith(APP_NAME),
        ).toBe(true);
      },
    );
  });

  describe('confirmRequest in English', () => {
    const englishVars = (overrides: Partial<MessageVars> = {}): MessageVars =>
      makeVars({ name: 'Moshe Cohen', ...overrides });

    it('writes name, the date as "Nov 5", link and sign-off, line by line', () => {
      expect(renderMessage('confirmRequest', englishVars(), undefined, 'en')).toBe(
        [
          'Hello Moshe Cohen,',
          'On Nov 5 we will come to collect your bottles.',
          'Please confirm the pickup at this link:',
          LINK,
          'Thank you, לתת עוד',
        ].join('\n'),
      );
    });

    it('writes the pickup time on a 12-hour clock', () => {
      expect(
        renderMessage('confirmRequest', englishVars({ pickupBy: '08:30' }), undefined, 'en'),
      ).toBe(
        [
          'Hello Moshe Cohen,',
          'On Nov 5 we will come to collect your bottles.',
          'Please put the bottles out by 8:30 AM.',
          'Please confirm the pickup at this link:',
          LINK,
          'Thank you, לתת עוד',
        ].join('\n'),
      );
    });

    it('writes a pickup window, with midnight as 12 AM and the afternoon as PM', () => {
      const text = renderMessage(
        'confirmRequest',
        englishVars({ pickupFrom: '00:30', pickupBy: '13:05' }),
        undefined,
        'en',
      );
      expect(text.split('\n')).toEqual([
        'Hello Moshe Cohen,',
        'On Nov 5 we will come to collect your bottles.',
        'Please put the bottles out between 12:30 AM and 1:05 PM.',
        'Please confirm the pickup at this link:',
        LINK,
        'Thank you, לתת עוד',
      ]);
    });

    it('keeps the personal text as Yoel wrote it, Hebrew included, never translated', () => {
      const text = renderMessage(
        'confirmRequest',
        englishVars({ pickupBy: '18:00' }),
        '  נאסוף אחרי מנחה\nWe come after 6 PM  ',
        'en',
      );
      expect(text.split('\n')).toEqual([
        'Hello Moshe Cohen,',
        'On Nov 5 we will come to collect your bottles.',
        'Please put the bottles out by 6:00 PM.',
        'נאסוף אחרי מנחה',
        'We come after 6 PM',
        'Please confirm the pickup at this link:',
        LINK,
        'Thank you, לתת עוד',
      ]);
    });

    it('leaves out a personal text that is empty or only spaces', () => {
      const withoutText = renderMessage('confirmRequest', englishVars(), undefined, 'en');
      for (const blank of ['', '   ', '\n\t \n']) {
        expect(
          renderMessage('confirmRequest', englishVars(), blank, 'en'),
          JSON.stringify(blank),
        ).toBe(withoutText);
      }
    });

    it('keeps a Hebrew name as it is and trims it', () => {
      expect(
        renderMessage('confirmRequest', makeVars({ name: ' משה ' }), undefined, 'en').split(
          '\n',
        )[0],
      ).toBe('Hello משה,');
    });

    it('keeps the brand name in Hebrew', () => {
      const text = renderMessage('confirmRequest', englishVars(), undefined, 'en');
      expect(text).toContain(APP_NAME);
      expect(text).not.toMatch(/latet od/i);
    });

    it('throws the same RangeErrors as in Hebrew, without the value', () => {
      const bad: Partial<MessageVars>[] = [
        { date: undefined },
        { date: '05/11/2026' },
        { pickupBy: '8:30' },
        { pickupFrom: '24:00', pickupBy: '08:30' },
        { pickupFrom: '07:00' },
      ];
      for (const overrides of bad) {
        const label = JSON.stringify(overrides);
        const english = errorOf(() =>
          renderMessage('confirmRequest', englishVars(overrides), undefined, 'en'),
        );
        const hebrew = errorOf(() => renderMessage('confirmRequest', makeVars(overrides)));
        expect(english, label).toBeInstanceOf(RangeError);
        expect(english.message, label).toBe(hebrew.message);
        for (const value of Object.values(overrides)) {
          if (value !== undefined) expect(english.message, label).not.toContain(value);
        }
      }
    });
  });

  describe('thankYou in English', () => {
    it('thanks, keeps the brand name in Hebrew and links for ordering again', () => {
      expect(renderMessage('thankYou', { name: ' Moshe ', link: LINK }, undefined, 'en')).toBe(
        [
          'Hello Moshe,',
          'Your order has been collected! Thank you for taking part in לתת עוד!',
          'To order again:',
          LINK,
        ].join('\n'),
      );
    });

    it('ignores the date, the pickup time and the personal text', () => {
      const plain = renderMessage('thankYou', { name: 'משה כהן', link: LINK }, undefined, 'en');
      expect(renderMessage('thankYou', makeVars({ pickupBy: '08:30' }), 'Personal', 'en')).toBe(
        plain,
      );
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
