// One labelled text input with its hint and its error next to it: the building block of every
// form in the app (the booking form, the collector's login). Styled by the `.field*` classes in
// styles.css; the page owns the value and the error, this component only shows them.
import { useId, type ReactNode, type Ref } from 'react';

/** The ids for `aria-describedby`, space-separated; undefined when there is none. */
function describedBy(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((id) => id !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
}

/** Props of {@link TextField}. */
export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Plain-Hebrew message shown under the input; the input is then marked invalid. */
  error: string | undefined;
  /** A short example or rule shown between the label and the input. */
  hint?: ReactNode;
  autoComplete: string;
  maxLength?: number;
  /**
   * 'tel' for the phone: phones offer their own number. 'password' for the login: the text is
   * hidden, and the phone's keyboard stops suggesting and capitalizing words.
   */
  type?: 'text' | 'tel' | 'password';
  /**
   * Digits (phone, number of bottles): the phone opens its numeric keyboard, and the digits read
   * left to right inside the right-to-left page (CLAUDE.md).
   */
  digits?: boolean;
  /** The `<input>` itself, for a page that moves focus to it or selects its text. */
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * One text field of a form: a visible label, an optional hint, the input, and its error next
 * to it. The hint and the error are linked to the input with aria-describedby, so a screen
 * reader reads them with the field.
 */
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  autoComplete,
  maxLength,
  type = 'text',
  digits = false,
  inputRef,
}: TextFieldProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const hasHint = hint !== undefined;

  return (
    <div className="field">
      <label htmlFor={inputId} className="field-label">
        {label}
      </label>
      {hasHint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      <input
        ref={inputRef}
        id={inputId}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        maxLength={maxLength}
        inputMode={digits ? 'numeric' : undefined}
        dir={digits ? 'ltr' : undefined}
        className={digits ? 'ltr' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hasHint ? hintId : undefined, error ? errorId : undefined)}
      />
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
