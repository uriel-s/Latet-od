// Turns the Hebrew messages of the shared schema and the api into the form's language. The shared
// `formErrorText` knows the ORDER_FORM_ERRORS; the phone's own message (PHONE_ERROR) and the
// form's "unknown field" line are handled here, so every message next to a field is translated.
import { PHONE_ERROR, formErrorText, t, type Lang } from '@bottlerun/shared';
import { UNKNOWN_FIELD_ERROR, type FormErrors } from './formValues.ts';

/** One field message in `lang`. Hebrew is returned unchanged. */
export function localizedFormMessage(lang: Lang, message: string): string {
  if (message === PHONE_ERROR) return t(lang, 'form.phoneInvalid');
  if (message === UNKNOWN_FIELD_ERROR) return t(lang, 'form.unknownField');
  return formErrorText(lang, message);
}

/** `errors` with every message in `lang` (the schema and the api answer in Hebrew). */
export function localizedFormErrors(lang: Lang, errors: FormErrors): FormErrors {
  const byField: FormErrors['byField'] = {};
  for (const [field, message] of Object.entries(errors.byField) as [
    keyof FormErrors['byField'],
    string | undefined,
  ][]) {
    if (message !== undefined) byField[field] = localizedFormMessage(lang, message);
  }
  return errors.other === undefined
    ? { byField }
    : { byField, other: localizedFormMessage(lang, errors.other) };
}
