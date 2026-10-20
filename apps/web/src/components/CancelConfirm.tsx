// "ביטול" with a question first, in plain words: a button that opens the question in the page,
// with "כן, לבטל" and "לא, להשאיר" under it. Shared by Yoel's edit screen (spec §3.5) and the
// customer's own page (spec §3.3, "שאלת אישור לפני ביטול"). The screen sends the cancel itself and
// tells this component whether it is on its way and why it failed; this component owns only the
// question being open and where focus goes.
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

const CONFIRM_CANCEL_LABEL = 'כן, לבטל';
const CANCELLING_LABEL = 'מבטל...';
const KEEP_LABEL = 'לא, להשאיר';

/** Props of {@link CancelConfirm}. */
export interface CancelConfirmProps {
  /** The button that opens the question, such as "ביטול ההזמנה". */
  buttonLabel: string;
  /** The question, such as "לבטל את ההזמנה?". It also names the group of the two answers. */
  question: string;
  /**
   * True while the cancel is on its way: "כן, לבטל" reads "מבטל...", both answers are
   * aria-disabled, and "לא, להשאיר" does nothing (the answer on its way decides).
   */
  cancelling: boolean;
  /** Why the last cancel did not go through, shown inside the question; null for nothing. */
  error: string | null;
  /**
   * "כן, לבטל" was tapped. Called on every tap, a busy one too: the screen keeps its own guard, so
   * a double tap sends one request.
   */
  onConfirm: () => void;
  /** The question opened or closed; the screen clears an old error here. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * The cancel button and, once tapped, the question in its place. A question in the page, not
 * `window.confirm`: big buttons in Hebrew, in words the screen chooses.
 *
 * Focus moves where the next step is: to the question when it opens (the button just tapped is
 * gone), and back to the button when "לא, להשאיר" closes it.
 */
export function CancelConfirm({
  buttonLabel,
  question,
  cancelling,
  error,
  onConfirm,
  onOpenChange,
}: CancelConfirmProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const questionId = useId();

  /**
   * Opens or closes the question. flushSync renders first, so the element to focus exists, and
   * the focus call stays inside the tap.
   */
  function showQuestion(next: boolean): void {
    flushSync(() => {
      setOpen(next);
      onOpenChange?.(next);
    });
    (next ? questionRef : buttonRef).current?.focus();
  }

  return (
    <div className="cancel-order">
      {open ? (
        <div role="group" aria-labelledby={questionId} className="cancel-confirm">
          {/* tabIndex -1: focusable from code, but not a stop when tabbing through the page. */}
          <p id={questionId} ref={questionRef} tabIndex={-1} className="cancel-confirm-question">
            {question}
          </p>
          {error !== null && (
            <p className="form-alert" role="alert">
              {error}
            </p>
          )}
          <div className="cancel-confirm-actions">
            {/* aria-disabled, not disabled, while cancelling: the button keeps focus and is
                announced as unavailable. */}
            <button
              type="button"
              className="button button-primary"
              aria-disabled={cancelling ? true : undefined}
              onClick={onConfirm}
            >
              {cancelling ? CANCELLING_LABEL : CONFIRM_CANCEL_LABEL}
            </button>
            <button
              type="button"
              className="button button-secondary"
              aria-disabled={cancelling ? true : undefined}
              onClick={() => {
                // While the cancel is on its way its answer decides; closing now would hide it.
                if (!cancelling) showQuestion(false);
              }}
            >
              {KEEP_LABEL}
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className="button button-secondary button-block"
          onClick={() => showQuestion(true)}
        >
          {buttonLabel}
        </button>
      )}
    </div>
  );
}
