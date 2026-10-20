// The street field (spec §3.1, ADR-0005): the customer types part of the name, taps their street
// in a short list from the official Beit Shemesh list, or taps "הרחוב שלי לא ברשימה" and writes
// it by hand. The booking form renders it for "רחוב"; Yoel's screen (section 6) renders it with
// `allowFreeText={false}` for "רחוב קרוב", which maps a hand-written address onto a listed street.
//
// Built for elderly customers: one big input, the matches as big buttons right under it (an
// ordinary list of buttons, not an ARIA combobox, which screen readers handle unevenly), and a
// short line in plain words that says what to do next.
import { useId, useRef, useState, type JSX, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { FORM_TEXT_MAX_LENGTH, STREETS, searchStreets, type Street } from '@bottlerun/shared';
import type { StreetChoice } from './streetChoice.ts';

/** At most this many matches are shown: more would push the rest of the form off the screen. */
export const MAX_STREET_RESULTS = 8;

/** Label of the input in free-text mode (it replaces the field's own label there). */
const FREE_TEXT_LABEL = 'שם הרחוב';
const FREE_TEXT_BUTTON = 'הרחוב שלי לא ברשימה';
const BACK_TO_LIST_BUTTON = 'חזרה לרשימת הרחובות';
const RESULTS_LIST_LABEL = 'רחובות שמתאימים לחיפוש';
const CHOSEN_STREET_PREFIX = 'נבחר:';
const NOT_FOUND = 'לא מצאנו רחוב בשם הזה.';

/** Props of {@link StreetPicker}. */
export interface StreetPickerProps {
  /** Visible label of the field, e.g. "רחוב" (the form) or "רחוב קרוב" (Yoel). */
  label: string;
  /** null = nothing chosen yet. */
  value: StreetChoice | null;
  onChange: (value: StreetChoice | null) => void;
  /** Offer "הרחוב שלי לא ברשימה" (free text). Default true; Yoel's "רחוב קרוב" passes false. */
  allowFreeText?: boolean;
  /** Plain-Hebrew error shown next to the field (the form passes its message for `street`). */
  error?: string;
  /**
   * A short line between the label and the input that says what the field is for (Yoel's "רחוב
   * קרוב" explains what picking one does). Read with the input, like TextField's hint.
   */
  hint?: ReactNode;
  /** Streets to search; defaults to the shared STREETS (tests may pass a short list). */
  streets?: readonly Street[];
}

type Mode = 'search' | 'freeText';

/**
 * The line under the input in search mode: what the search found and what to do next. Empty
 * while there is nothing to say (no text yet, or the chosen street is already in the input).
 */
function searchStatus(matchCount: number, allowFreeText: boolean): string {
  if (matchCount === 0) {
    return allowFreeText
      ? `${NOT_FOUND} אפשר לכתוב את השם אחרת, או ללחוץ על "${FREE_TEXT_BUTTON}".`
      : `${NOT_FOUND} אפשר לכתוב את השם אחרת.`;
  }
  if (matchCount === 1) return 'נמצא רחוב אחד. נא ללחוץ עליו.';
  // Only the first MAX_STREET_RESULTS are shown, so a street further down the matches would
  // never appear: the customer has to narrow the search by typing more of the name.
  if (matchCount > MAX_STREET_RESULTS) {
    return 'נמצאו הרבה רחובות. נא להמשיך לכתוב את השם, או ללחוץ על הרחוב הנכון.';
  }
  return `נמצאו ${matchCount} רחובות. נא ללחוץ על הרחוב הנכון.`;
}

/**
 * The street field: search the official list, or (when `allowFreeText`) write the street by hand.
 * Renders a whole `.field` (label, input, error, matches), so place it among the form's other
 * fields as is, not inside another `.field`.
 *
 * - Search mode (`value` null or `listed`): the input is labelled `label`. Typing shows up to
 *   {@link MAX_STREET_RESULTS} matches as buttons named by the official street name; tapping one
 *   calls `onChange({ kind: 'listed', code, name })` and puts the name in the input. Editing the
 *   text after a choice calls `onChange(null)`.
 * - Free-text mode (`value` `freeText`): the input is labelled "שם הרחוב", and every keystroke
 *   calls `onChange({ kind: 'freeText', name })`. "הרחוב שלי לא ברשימה" enters it (keeping what
 *   was typed, trimmed); "חזרה לרשימת הרחובות" leaves it with `onChange(null)`.
 *
 * The text in the input is the component's own state, initialised from `value` (a returning
 * customer's saved street) and not resynced when `value` changes from outside later: a parent
 * that resets or refills the field remounts it with a new `key`.
 */
export function StreetPicker({
  label,
  value,
  onChange,
  allowFreeText = true,
  error,
  hint,
  streets = STREETS,
}: StreetPickerProps): JSX.Element {
  const [mode, setMode] = useState<Mode>(
    value?.kind === 'freeText' && allowFreeText ? 'freeText' : 'search',
  );
  // What the input shows: the search text in search mode, the street's name in free-text mode.
  const [text, setText] = useState(value?.name ?? '');
  // "נבחר: <רחוב>", told through the status line after a keyboard choice; cleared on the next edit.
  const [chosenNote, setChosenNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const hasHint = hint !== undefined;
  // The hint and the error, space-separated, so a screen reader reads both with the input.
  const describedBy =
    [hasHint ? hintId : undefined, error ? errorId : undefined]
      .filter((id) => id !== undefined)
      .join(' ') || undefined;

  // A street just chosen (or prefilled) is already in the input: its list has done its job.
  const showsChosenStreet = value?.kind === 'listed' && value.name === text;
  const searching = mode === 'search' && !showsChosenStreet && text.trim() !== '';
  const matches = searching ? searchStreets(text, streets) : [];
  const status = searching ? searchStatus(matches.length, allowFreeText) : '';

  function handleTextChange(nextText: string): void {
    setText(nextText);
    setChosenNote('');
    if (mode === 'freeText') {
      onChange({ kind: 'freeText', name: nextText });
    } else if (value !== null) {
      // The text no longer is the chosen street's name, so the choice no longer holds.
      onChange(null);
    }
  }

  /**
   * `fromKeyboard`: the tap came from Enter or Space, or a screen reader (a click with no pointer,
   * `event.detail === 0`). The list closes and the button just used is gone, so focus goes back to
   * the input, and the status line says what was chosen. A finger tap leaves focus alone: on a
   * phone, focusing the input here would raise the keyboard again right after the choice.
   */
  function chooseStreet(street: Street, fromKeyboard: boolean): void {
    setText(street.name);
    onChange({ kind: 'listed', code: street.code, name: street.name });
    if (fromKeyboard) {
      setChosenNote(`${CHOSEN_STREET_PREFIX} ${street.name}`);
      inputRef.current?.focus();
    }
  }

  /**
   * Switches between search and free text, then moves focus to the input so a keyboard or
   * screen-reader user lands where they type next (the button they pressed disappears).
   * flushSync renders the new mode first, so the input is announced with its new label; and the
   * focus stays inside the tap's own handler, which is what lets iOS open the keyboard.
   */
  function switchMode(nextMode: Mode, nextText: string, nextValue: StreetChoice | null): void {
    flushSync(() => {
      setMode(nextMode);
      setText(nextText);
      onChange(nextValue);
    });
    inputRef.current?.focus();
  }

  function enterFreeText(): void {
    const name = text.trim();
    switchMode('freeText', name, { kind: 'freeText', name });
  }

  function backToSearch(): void {
    // The text stays: it searches the list again, in case the street is there after all.
    switchMode('search', text, null);
  }

  return (
    <div className="field street-picker">
      <label htmlFor={inputId} className="field-label">
        {mode === 'search' ? label : FREE_TEXT_LABEL}
      </label>
      {hasHint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {/* One input for both modes; only its label and meaning change. */}
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        value={text}
        onChange={(event) => handleTextChange(event.target.value)}
        // The browser's own suggestions would cover the list of streets.
        autoComplete="off"
        // The limit the api enforces on a hand-written name; also longer than any listed name.
        maxLength={FORM_TEXT_MAX_LENGTH.streetName}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}

      {mode === 'search' ? (
        <>
          {/* Always rendered, so screen readers announce the line when its text changes. */}
          <p className="field-hint" aria-live="polite">
            {status || chosenNote}
          </p>
          {matches.length > 0 && (
            <ul className="street-results" aria-label={RESULTS_LIST_LABEL}>
              {matches.slice(0, MAX_STREET_RESULTS).map((street) => (
                <li key={street.code}>
                  <button
                    type="button"
                    className="street-result"
                    onClick={(event) => chooseStreet(street, event.detail === 0)}
                  >
                    {street.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {allowFreeText && (
            <button
              type="button"
              className="link-button street-picker-switch"
              onClick={enterFreeText}
            >
              {FREE_TEXT_BUTTON}
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          className="button button-secondary street-picker-switch"
          onClick={backToSearch}
        >
          {BACK_TO_LIST_BUTTON}
        </button>
      )}
    </div>
  );
}
