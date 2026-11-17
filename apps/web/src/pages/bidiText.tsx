import { Fragment, type ReactNode } from 'react';
import { t, type Lang, type MessageKey } from '@bottlerun/shared';

/**
 * `text` (from t(), written with a `{date}` placeholder) with the day set in a left-to-right
 * `<bdi>`: DD/MM and "Nov 12" read left to right inside right-to-left text (CLAUDE.md).
 */
function withDay(text: string, day: string): ReactNode {
  const [before = '', after = ''] = text.split(DAY_PLACEHOLDER);
  return (
    <>
      {before}
      <bdi dir="ltr">{day}</bdi>
      {after}
    </>
  );
}

/** A `{date}` that t() leaves as it is when passed as its own value. */
const DAY_PLACEHOLDER = '{date}';

/** {@link t} with `{date}` left in the text, for {@link withDay}. */
export function tWithDay(lang: Lang, key: MessageKey, day: string): ReactNode {
  return withDay(t(lang, key, { date: DAY_PLACEHOLDER }), day);
}

/** `{from}` and `{by}` left in the text by t(), for {@link timesText} to fill. */
export const TIME_PLACEHOLDERS = { from: '{from}', by: '{by}' } as const;

/** `text` with each time (in the order they appear) set in a left-to-right `<bdi>`. */
export function timesText(text: string, times: readonly string[]): ReactNode {
  const parts = text.split(/\{(?:from|by)\}/);
  return parts.map((part, index) => (
    // The parts never reorder, so the index is a stable key.
    <Fragment key={index}>
      {part}
      {index < times.length && <bdi dir="ltr">{times[index]}</bdi>}
    </Fragment>
  ));
}
