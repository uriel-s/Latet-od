// The quantity form "אספתי" opens in a stop card: − / +, the field, "שמור" and "ביטול".
import { useState, type RefObject } from 'react';
import { COLLECT_STOP_ERRORS, MAX_BOTTLES, collectStopRequestSchema } from '@bottlerun/shared';
import { TextField } from '../components/TextField.tsx';

/** The label of the quantity field "אספתי" opens. */
export const BOTTLES_COLLECTED_LABEL = 'כמה בקבוקים נאספו';

const SAVING_LABEL = 'שומר...';

/**
 * The quantity Yoel typed, checked with the api's own rules ({@link collectStopRequestSchema}):
 * a whole number from 1 up to MAX_BOTTLES. Digits only, so a blank field, "2.5", "4,5" or "1e3"
 * gets the plain message instead of becoming a number the api would refuse or misread (as in the
 * booking form's bottles field, order.ts). Below 20 is fine: the real count can be lower than the
 * estimate; the minimum is a booking rule only.
 */
export function parseBottlesCollected(
  text: string,
): { ok: true; bottlesCollected: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: COLLECT_STOP_ERRORS.bottlesInvalid };
  const parsed = collectStopRequestSchema.safeParse({ bottlesCollected: Number(trimmed) });
  if (parsed.success && parsed.data.bottlesCollected !== undefined) {
    return { ok: true, bottlesCollected: parsed.data.bottlesCollected };
  }
  return {
    ok: false,
    message: parsed.error?.issues[0]?.message ?? COLLECT_STOP_ERRORS.bottlesInvalid,
  };
}

/** Props of {@link CollectQuantityForm}. */
export interface CollectQuantityFormProps {
  bottlesEstimated: number;
  /** The save is on its way: buttons aria-disabled, the tap does nothing. */
  busy: boolean;
  /** The api's message for the quantity (400 invalid_collect), shown next to the field. */
  bottlesError: string | undefined;
  /**
   * The input, owned by the card: iOS opens the keyboard only when focus() runs inside the tap
   * itself, so the card focuses and selects it right after its flushSync open, not in an effect.
   */
  inputRef: RefObject<HTMLInputElement | null>;
  /** "שמור" with a validated whole number. */
  onSave: (bottlesCollected: number) => void;
  /** "ביטול" (never while busy). */
  onCancel: () => void;
}

/**
 * Mounted only while open, so every opening starts again from the estimate: most of the time
 * Yoel only taps "שמור".
 */
export function CollectQuantityForm({
  bottlesEstimated,
  busy,
  bottlesError,
  inputRef,
  onSave,
  onCancel,
}: CollectQuantityFormProps) {
  const [quantity, setQuantity] = useState(() => String(bottlesEstimated));
  const [quantityError, setQuantityError] = useState<string | undefined>(undefined);
  // aria-disabled, not disabled, while busy: a button keeps focus and is announced as
  // unavailable, and its tap does nothing (the screen keeps its own guard too).
  const ariaBusy = busy ? true : undefined;

  /** The − / + buttons: one bottle at a time, never below 1 or above what the api accepts. */
  function step(delta: 1 | -1): void {
    const typed = quantity.trim();
    // A blank or half-typed field steps from the estimate, so the buttons always do something.
    const base = /^\d+$/.test(typed) ? Number(typed) : bottlesEstimated;
    setQuantity(String(Math.min(MAX_BOTTLES, Math.max(1, base + delta))));
    setQuantityError(undefined);
  }

  function save(): void {
    if (busy) return;
    const result = parseBottlesCollected(quantity);
    if (!result.ok) {
      setQuantityError(result.message);
      inputRef.current?.focus();
      return;
    }
    setQuantityError(undefined);
    onSave(result.bottlesCollected);
  }

  return (
    // A form, so the phone keyboard's "Go" saves too. noValidate: the card checks the number
    // itself and says what is wrong in plain words.
    <form
      className="stop-card-quantity"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="bottles-stepper">
        <button
          type="button"
          className="button button-secondary bottles-stepper-button"
          aria-label="הפחת בקבוק"
          aria-disabled={ariaBusy}
          onClick={() => {
            if (!busy) step(-1);
          }}
        >
          <span aria-hidden="true">−</span>
        </button>
        <TextField
          label={BOTTLES_COLLECTED_LABEL}
          value={quantity}
          onChange={(value) => {
            setQuantity(value);
            setQuantityError(undefined);
          }}
          error={quantityError ?? bottlesError}
          autoComplete="off"
          digits
          inputRef={inputRef}
        />
        <button
          type="button"
          className="button button-secondary bottles-stepper-button"
          aria-label="הוסף בקבוק"
          aria-disabled={ariaBusy}
          onClick={() => {
            if (!busy) step(1);
          }}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
      <div className="cancel-confirm-actions">
        <button type="submit" className="button button-primary button-big" aria-disabled={ariaBusy}>
          {busy ? SAVING_LABEL : 'שמור'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          aria-disabled={ariaBusy}
          onClick={() => {
            // While the save is on its way its answer decides; closing now would hide it.
            if (!busy) onCancel();
          }}
        >
          ביטול
        </button>
      </div>
    </form>
  );
}
