import { describe, expect, it } from 'vitest';
import { DEFAULT_LANG, MESSAGES, langSchema, t, translate, type Dictionary } from './i18n.ts';

/** A small dictionary for translate: the app's own dictionary starts empty. */
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
});
