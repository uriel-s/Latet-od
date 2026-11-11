import { describe, expect, it } from 'vitest';
import { CUSTOMER_ORDER_MESSAGES } from './customerOrderApi.ts';
import {
  DEFAULT_LANG,
  MESSAGES,
  langSchema,
  t,
  translate,
  type Dictionary,
  type Lang,
  type MessageKey,
} from './i18n.ts';
import { APP_SLOGAN } from './index.ts';
import { BOTTLES_SPOT_LABELS, MIN_BOTTLES, ORDER_FORM_ERRORS, bottlesSpotSchema } from './order.ts';
import { CREATE_ORDER_MESSAGES } from './orderApi.ts';
import { PHONE_ERROR } from './phone.ts';
import { ORDER_STATUSES, ORDER_STATUS_LABELS, type OrderStatus } from './orderStatus.ts';

/** A small dictionary for translate, independent of the app's own texts. */
const TEST: Dictionary<'greeting' | 'plain' | 'twice' | 'pair' | 'unknown'> = {
  he: {
    greeting: 'שלום {name}',
    plain: 'טקסט',
    twice: '{name} ו{name}',
    pair: '{count} בקבוקים ב{date}',
    unknown: 'שלום {missing}',
  },
  en: {
    greeting: 'Hello {name}',
    plain: 'Text',
    twice: '{name} and {name}',
    pair: '{count} bottles on {date}',
    unknown: 'Hello {missing}',
  },
};

describe('langSchema', () => {
  it('accepts he and en', () => {
    expect(langSchema.parse('he')).toBe('he');
    expect(langSchema.parse('en')).toBe('en');
  });

  it.each(['fr', '', 'HE', undefined])('rejects %j', (value) => {
    expect(langSchema.safeParse(value).success).toBe(false);
  });
});

describe('DEFAULT_LANG', () => {
  it('is Hebrew', () => {
    expect(DEFAULT_LANG).toBe('he');
  });
});

describe('translate', () => {
  it('picks the text of the given language', () => {
    expect(translate(TEST, 'he', 'plain')).toBe('טקסט');
    expect(translate(TEST, 'en', 'plain')).toBe('Text');
  });

  it('replaces a placeholder with its value', () => {
    expect(translate(TEST, 'he', 'greeting', { name: 'משה' })).toBe('שלום משה');
    expect(translate(TEST, 'en', 'greeting', { name: 'Moshe' })).toBe('Hello Moshe');
  });

  it('replaces a repeated placeholder everywhere', () => {
    expect(translate(TEST, 'en', 'twice', { name: 'Dan' })).toBe('Dan and Dan');
  });

  it('replaces several placeholders and inserts numbers as text', () => {
    expect(translate(TEST, 'en', 'pair', { count: 40, date: '05/11' })).toBe('40 bottles on 05/11');
    expect(translate(TEST, 'en', 'pair', { count: 0, date: '05/11' })).toBe('0 bottles on 05/11');
  });

  it('leaves a placeholder with no value as written', () => {
    expect(translate(TEST, 'en', 'unknown', { name: 'Dan' })).toBe('Hello {missing}');
    expect(translate(TEST, 'en', 'greeting')).toBe('Hello {name}');
  });

  it('does not take a placeholder value from Object.prototype', () => {
    const dictionary: Dictionary<'proto'> = {
      he: { proto: '{toString}' },
      en: { proto: '{toString}' },
    };
    expect(translate(dictionary, 'en', 'proto', {})).toBe('{toString}');
  });

  it('returns a text without placeholders unchanged when vars are given', () => {
    expect(translate(TEST, 'he', 'plain', { name: 'משה' })).toBe('טקסט');
  });

  it('inserts a value literally, without substituting braces inside it', () => {
    expect(translate(TEST, 'en', 'greeting', { name: '{name}' })).toBe('Hello {name}');
    expect(translate(TEST, 'en', 'pair', { count: '{date}', date: '05/11' })).toBe(
      '{date} bottles on 05/11',
    );
  });
});

describe('MESSAGES', () => {
  it('has the same keys in every language', () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES.he).sort());
  });

  // The dictionary's Hebrew is a copy of constants the api and zod still use (see i18n.ts): a
  // change to one side only must fail here, or the web would show a different text than the api.
  describe('Hebrew copies of the older constants', () => {
    it('has the slogan as APP_SLOGAN', () => {
      expect(t('he', 'appSlogan')).toBe(APP_SLOGAN);
    });

    it.each(Object.entries(ORDER_FORM_ERRORS))(
      'has formError.%s as ORDER_FORM_ERRORS',
      (key, he) => {
        expect(
          t('he', `formError.${key as keyof typeof ORDER_FORM_ERRORS}`, { min: MIN_BOTTLES }),
        ).toBe(he);
      },
    );

    it('has form.phoneInvalid as PHONE_ERROR', () => {
      expect(t('he', 'form.phoneInvalid')).toBe(PHONE_ERROR);
    });

    it.each(bottlesSpotSchema.options)('has bottlesSpot.%s as BOTTLES_SPOT_LABELS', (spot) => {
      expect(t('he', `bottlesSpot.${spot}`)).toBe(BOTTLES_SPOT_LABELS[spot]);
    });

    it.each(ORDER_STATUSES)('has orderStatus.%s as ORDER_STATUS_LABELS', (status) => {
      expect(t('he', `orderStatus.${status}`)).toBe(ORDER_STATUS_LABELS[status]);
    });

    it.each(Object.entries(CREATE_ORDER_MESSAGES))(
      'has createOrder.%s as CREATE_ORDER_MESSAGES',
      (key, he) => {
        expect(t('he', `createOrder.${key as keyof typeof CREATE_ORDER_MESSAGES}`)).toBe(he);
      },
    );

    it.each(Object.entries(CUSTOMER_ORDER_MESSAGES))(
      'has customerOrder.%s as CUSTOMER_ORDER_MESSAGES',
      (key, he) => {
        expect(t('he', `customerOrder.${key as keyof typeof CUSTOMER_ORDER_MESSAGES}`)).toBe(he);
      },
    );

    it('has no copied key without its constant', () => {
      const copied = [
        'appSlogan',
        ...Object.keys(ORDER_FORM_ERRORS).map((key) => `formError.${key}`),
        ...bottlesSpotSchema.options.map((spot) => `bottlesSpot.${spot}`),
        ...ORDER_STATUSES.map((status) => `orderStatus.${status}`),
        ...Object.keys(CREATE_ORDER_MESSAGES).map((key) => `createOrder.${key}`),
        ...Object.keys(CUSTOMER_ORDER_MESSAGES).map((key) => `customerOrder.${key}`),
      ];
      const groups = /^(appSlogan|formError|bottlesSpot|orderStatus|createOrder|customerOrder)\b/;
      const inDictionary = Object.keys(MESSAGES.he).filter((key) => groups.test(key));
      expect(inDictionary.sort()).toEqual(copied.sort());
    });
  });

  it.each(Object.keys(MESSAGES.he) as MessageKey[])('has a real English text for %s', (key) => {
    expect(MESSAGES.en[key].trim()).not.toBe('');
    expect(MESSAGES.en[key]).not.toBe(MESSAGES.he[key]);
  });

  it('has the English texts as written', () => {
    expect(t('en', 'appSlogan')).toBe('Your bottles, their tefillin!');
    expect(t('en', 'formError.bottlesTooFew', { min: MIN_BOTTLES })).toBe(
      `At least ${MIN_BOTTLES} bottles are needed`,
    );
    expect(t('en', 'bottlesSpot.apartmentDoor')).toBe('In a building - by the apartment door');
    expect(t('en', 'bottlesSpot.other')).toBe('Other (I will specify in the note)');
    expect(t('he', 'bottlesSpot.other')).toBe('אחר (אפרט בהערות)');
    expect(t('en', 'orderStatus.waiting')).toBe('Waiting for a round');
    expect(t('en', 'createOrder.duplicateOpenOrder')).toBe(
      'There is already an open order for this number.',
    );
    expect(t('en', 'customerOrder.orderNotFound')).toBe(
      'We could not find the order. The link may not have been copied in full.',
    );
    expect(t('en', 'whatsapp.greeting', { name: 'Moshe' })).toBe('Hello Moshe,');
    expect(t('en', 'whatsapp.confirmRequest.putOutBy', { from: '7:00 AM' })).toBe(
      'Please put the bottles outside by 7:00 AM.',
    );
    expect(
      t('en', 'whatsapp.confirmRequest.arrivalWindow', { from: '7:00 AM', by: '8:30 AM' }),
    ).toBe('We will come to collect between 7:00 AM and 8:30 AM.');
  });

  // The brand is a name, not a word to translate: English WhatsApp texts that mention it keep it
  // in Hebrew, as the customer knows it.
  it.each(['whatsapp.confirmRequest.signOff', 'whatsapp.thankYou.thanks'] as const)(
    'keeps the brand name in Hebrew in %s',
    (key) => {
      expect(t('en', key)).toContain('לתת עוד');
    },
  );
});

// Type-level checks: `tsc` (checks.sh types) fails with "Unused '@ts-expect-error'" if any of these
// stops being a type error. The runtime assertions only keep the values used.
describe('Dictionary and key types', () => {
  it('refuses a dictionary whose English is missing a key', () => {
    const missing: Dictionary<'a' | 'b'> = {
      he: { a: 'א', b: 'ב' },
      // @ts-expect-error -- `b` is missing from en
      en: { a: 'A' },
    };
    expect(missing.he.a).toBe('א');
  });

  it('refuses a dictionary with an extra key in one language', () => {
    const extra: Dictionary<'a'> = {
      // @ts-expect-error -- `b` is not a key of this dictionary
      he: { a: 'א', b: 'ב' },
      en: { a: 'A' },
    };
    expect(extra.en.a).toBe('A');
  });

  it('refuses an unknown key in translate and t', () => {
    // @ts-expect-error -- 'nope' is not a key of TEST
    expect(translate(TEST, 'en', 'nope')).toBeUndefined();
    // @ts-expect-error -- 'nope' is not a key of the app's dictionary
    expect(t('en', 'nope')).toBeUndefined();
  });

  it('accepts a key built from a status variable', () => {
    // A template-literal key over OrderStatus is a union of MessageKeys, so this type-checks with
    // no cast; a status without its `orderStatus.*` text would make it a type error.
    const statusLabel = (lang: Lang, status: OrderStatus): string =>
      t(lang, `orderStatus.${status}`);
    expect(statusLabel('en', 'collected')).toBe('Collected');
    expect(statusLabel('he', 'collected')).toBe('נאספה');
  });
});
