// UI language and translated text. The app is Hebrew first; English is an optional second
// language for customers who do not read Hebrew. No i18n library on purpose (zero cost, minimum
// moving parts): a dictionary is a plain object per language, and the type system makes every
// language carry exactly the same keys, so a missing translation fails `tsc`, not a customer.
import { z } from 'zod';

/** A language the UI speaks: `he` = Hebrew (right-to-left), `en` = English (left-to-right). */
export const langSchema = z.enum(['he', 'en']);
export type Lang = z.infer<typeof langSchema>;

/**
 * The language when none was chosen. Hebrew: the app was built for Hebrew speakers, and an order
 * stored before languages existed has no `lang` and reads as Hebrew.
 */
export const DEFAULT_LANG: Lang = 'he';

/**
 * Texts by language, then by key. Every language has exactly the keys `K`: a key missing from one
 * language is a type error, and so is an extra key in one language's object literal (excess
 * property check). Texts may hold `{name}` placeholders, filled by {@link translate}.
 */
export type Dictionary<K extends string> = Readonly<Record<Lang, Readonly<Record<K, string>>>>;

/** Values for a text's `{name}` placeholders. Numbers are inserted with `String(value)`. */
export type TranslationVars = Readonly<Record<string, string | number>>;

/** One `{name}` placeholder: a word in braces. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The text of `key` in `lang`, with every `{name}` placeholder replaced by `vars[name]`.
 *
 * A placeholder with no value in `vars` stays as written (`{name}`) instead of throwing: a missing
 * value is a bug to see on screen, not a crash of the whole page. Values are inserted literally
 * in one pass, so a value that itself contains `{x}` is not substituted again.
 */
export function translate<K extends string>(
  dictionary: Dictionary<K>,
  lang: Lang,
  key: K,
  vars?: TranslationVars,
): string {
  const text = dictionary[lang][key];
  if (vars === undefined) return text;
  return text.replace(PLACEHOLDER, (placeholder, name: string) =>
    // Object.hasOwn, not `name in vars`: `{toString}` must not pick up Object.prototype.toString.
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  );
}

// ---------------------------------------------------------------------------------------------
// The app's dictionary
// ---------------------------------------------------------------------------------------------
//
// HOW TO ADD A TEXT: add the key with its Hebrew text to HE, then the same key to EN. HE is the
// source of the key list (MessageKey); EN must satisfy Record<MessageKey, string>, so forgetting
// the English text, or an English-only key, fails `tsc`. Keep keys grouped by screen with a short
// comment, e.g. `formTitle: 'הזמנת איסוף בקבוקים'`. Empty for now: sections add keys as they
// translate their screens.

/** Hebrew texts. Its keys define {@link MessageKey}. */
const HE = {} as const satisfies Record<string, string>;

/** A key of the app's dictionary. */
export type MessageKey = keyof typeof HE;

/** English texts: the same keys as {@link HE}, no more and no fewer. */
const EN = {} as const satisfies Record<MessageKey, string>;

/** The app's dictionary: every UI text in every {@link Lang}. Read it through {@link t}. */
export const MESSAGES: Dictionary<MessageKey> = { he: HE, en: EN };

/** The app text of `key` in `lang`, placeholders filled from `vars` (see {@link translate}). */
export function t(lang: Lang, key: MessageKey, vars?: TranslationVars): string {
  return translate(MESSAGES, lang, key, vars);
}
