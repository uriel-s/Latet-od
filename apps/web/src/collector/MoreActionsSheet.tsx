// The "⋯" bottom sheet of a stop still to collect (ADR-0011): "לא נמצא" (with its question, asked
// inside the sheet), the two arrows that move the stop in the route, and "סגור". Same pattern as
// RoundPickerSheet.tsx (RoundPicker): a modal dialog, focus moves in on open, Escape / "סגור" /
// the dark background close it. Presentational: the card owns whether it is open and gives the
// focus back to its "⋯" button after onClose; the route screen sends the requests. On an upcoming
// stop (compact timeline card, no buttons of its own) the sheet also carries "אספתי", "נווט" and
// "חייג", so collecting out of order and every other action stay one tap away.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../components/Icon.tsx';

/** The in-sheet question "לא נמצא" opens: a mistap would otherwise block "אספתי" (stop_handled). */
export const NOT_FOUND_QUESTION = 'לסמן שהלקוח לא נמצא?';

/** The button that closes the sheet without doing anything. */
export const MORE_ACTIONS_CLOSE_LABEL = 'סגור';

const SAVING_LABEL = 'שומר...';

/** Props of {@link MoreActionsSheet}. */
export interface MoreActionsSheetProps {
  /** The customer's name: the sheet's accessible name says whose stop this is. */
  name: string;
  /** Whether "הזז למעלה" shows (the route screen's storedMovesFor(...) > 0). */
  canMoveUp: boolean;
  /** Whether "הזז למטה" shows. */
  canMoveDown: boolean;
  /** An action of the card is on its way: buttons aria-disabled, the tap does nothing. */
  busy: boolean;
  /** An arrow was tapped; the sheet closes itself first. */
  onMove: (direction: 'up' | 'down') => void;
  /** "כן, לא נמצא" in the sheet's question. */
  onNotFound: () => void;
  /**
   * Upcoming stops only: "אספתי" at the top of the sheet (Yoel collects out of order). The card
   * closes the sheet and opens its quantity stepper. Left out, no "אספתי" shows.
   */
  onCollect?: () => void;
  /** Upcoming stops only: the Waze link, shown as "נווט" in the sheet. */
  navigateUrl?: string;
  /** Upcoming stops only: the `tel:` link, shown as "חייג" in the sheet. */
  phoneUrl?: string;
  /** Escape, "סגור", the background or an arrow: the card closes the sheet and refocuses "⋯". */
  onClose: () => void;
}

/** The sheet; render it only while open. Focus lands on the dialog itself so its name is read. */
export function MoreActionsSheet({
  name,
  canMoveUp,
  canMoveDown,
  busy,
  onMove,
  onNotFound,
  onCollect,
  navigateUrl,
  phoneUrl,
  onClose,
}: MoreActionsSheetProps) {
  const [asking, setAsking] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const titleId = useId();
  const questionId = useId();
  const ariaBusy = busy ? true : undefined;

  useEffect(() => {
    dialogRef.current?.focus();
    // Lock the page's scroll while the sheet is open; put back whatever was there.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // The question replaces the actions, so the focus follows it (the tapped button is gone).
  useEffect(() => {
    if (asking) questionRef.current?.focus();
  }, [asking]);

  /** Escape closes; Tab wraps from the last control to the first and back, so it cannot leave. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href]'));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (
      event.shiftKey &&
      (active === first || active === dialog || active === questionRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <div className="round-picker-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="round-picker-sheet more-actions-sheet"
        onKeyDown={handleKeyDown}
      >
        <p id={titleId} className="round-picker-title">
          עוד פעולות, {name}
        </p>

        {asking ? (
          <div role="group" aria-labelledby={questionId} className="cancel-confirm">
            {/* tabIndex -1: focusable from code, but not a stop when tabbing through the page. */}
            <p id={questionId} ref={questionRef} tabIndex={-1} className="cancel-confirm-question">
              {NOT_FOUND_QUESTION}
            </p>
            <div className="cancel-confirm-actions">
              <button
                type="button"
                className="button button-primary"
                aria-disabled={ariaBusy}
                onClick={() => {
                  if (!busy) onNotFound();
                }}
              >
                {busy ? SAVING_LABEL : 'כן, לא נמצא'}
              </button>
              <button
                type="button"
                className="button button-secondary"
                aria-disabled={ariaBusy}
                onClick={() => {
                  // While the answer is on its way it decides; closing now would hide it.
                  if (!busy) setAsking(false);
                }}
              >
                לא
              </button>
            </div>
          </div>
        ) : (
          <div className="more-actions-list">
            {onCollect !== undefined && (
              <button
                type="button"
                className="button button-primary button-block"
                aria-disabled={ariaBusy}
                onClick={() => {
                  if (!busy) onCollect();
                }}
              >
                <Icon name="check" />
                אספתי
              </button>
            )}
            {navigateUrl !== undefined && (
              <a
                className="button button-secondary button-block"
                href={navigateUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="navigate" />
                נווט
              </a>
            )}
            {phoneUrl !== undefined && (
              <a className="button button-secondary button-block" href={phoneUrl}>
                <Icon name="phone" />
                חייג
              </a>
            )}
            <button
              type="button"
              className="button button-secondary button-block"
              aria-disabled={ariaBusy}
              onClick={() => {
                if (!busy) setAsking(true);
              }}
            >
              לא נמצא
            </button>
            {canMoveUp && (
              <button
                type="button"
                className="button button-secondary button-block"
                aria-disabled={ariaBusy}
                onClick={() => {
                  if (busy) return;
                  onMove('up');
                  onClose();
                }}
              >
                {/* The arrow first and hidden, so the accessible name starts with the words. */}
                <span aria-hidden="true">▲</span> הזז למעלה
              </button>
            )}
            {canMoveDown && (
              <button
                type="button"
                className="button button-secondary button-block"
                aria-disabled={ariaBusy}
                onClick={() => {
                  if (busy) return;
                  onMove('down');
                  onClose();
                }}
              >
                <span aria-hidden="true">▼</span> הזז למטה
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          className="button button-secondary button-block round-picker-close"
          onClick={onClose}
        >
          {MORE_ACTIONS_CLOSE_LABEL}
        </button>
      </div>
    </>
  );
}
