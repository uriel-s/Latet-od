// "סגור אישורים ובנה מסלול", the last step of a round still confirming (spec §3.6): a button, and
// once tapped a question in the page that says how many customers go back to waiting. The rounds
// screen (RoundsScreen.tsx) sends the build itself and tells this component whether it is on its
// way and whether it failed; this component owns only the question being open and the focus.
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/** The button at the end of a round in step 1 (spec §3.6). */
export const BUILD_ROUTE_LABEL = 'סגור אישורים ובנה מסלול';
/** "Yes" of the question: builds the route. */
export const BUILD_ROUTE_YES_LABEL = 'כן, לבנות מסלול';
/** "No" of the question: back to the button, nothing sent. */
export const BUILD_ROUTE_NO_LABEL = 'לא, עוד לא';
/** "Yes" while the build is on its way. */
export const BUILDING_ROUTE_LABEL = 'בונה מסלול...';

/** Inside the question when the build got no usable answer; "כן" can be tapped again. */
export const BUILD_ROUTE_FAILED_MESSAGE = 'לא הצלחנו לבנות את המסלול. נא לנסות שוב.';

/**
 * The question "סגור אישורים ובנה מסלול" asks first, in plain words: building the route closes the
 * confirmations, and whoever has not confirmed leaves the round and waits for the next one (spec
 * §3.6, ת5), so Yoel hears how many that is before he decides. `pendingCount` is the size of the
 * "עוד לא אישרו" group.
 *
 * With none pending it says no one goes back to waiting: true also for a round whose customers
 * all asked for another date (rare, and building it is harmless: an empty route).
 */
export function buildRouteQuestion(pendingCount: number): string {
  const question = 'לסגור את האישורים ולבנות מסלול?';
  if (pendingCount === 0) return `אף לקוח לא יחזור לחכות. ${question}`;
  if (pendingCount === 1) return `לקוח אחד שעוד לא אישר יחזור לחכות לסבב הבא. ${question}`;
  return `${pendingCount} לקוחות שעוד לא אישרו יחזרו לחכות לסבב הבא. ${question}`;
}

/**
 * What the rounds screen tells a step-1 section about its build, and how the section reaches back;
 * the screen sends the request.
 */
export interface BuildRouteControl {
  /** True while the build is on its way ("בונה מסלול..."). */
  building: boolean;
  /** True when the last build got no usable answer. */
  failed: boolean;
  /** "כן, לבנות מסלול". Called on every tap, a busy one too: the screen keeps its own guard. */
  onBuild: () => void;
  /** The question opened or closed; the screen clears an old error here. */
  onOpenChange: () => void;
}

/** Props of {@link BuildRouteConfirm}. */
export interface BuildRouteConfirmProps extends BuildRouteControl {
  /** From {@link buildRouteQuestion}; it also names the group of the two answers. */
  question: string;
}

/**
 * "סגור אישורים ובנה מסלול" and, once tapped, its question in its place, with
 * "כן, לבנות מסלול" and "לא, עוד לא" under it. Built like components/CancelConfirm.tsx, whose
 * words are the cancel's: a question in the page, not `window.confirm`, and the focus where the
 * next step is (to the question when it opens, back to the button on "לא, עוד לא"). The question
 * stays open after a failed build, with the error inside it, for another "כן".
 */
export function BuildRouteConfirm({
  question,
  building,
  failed,
  onBuild,
  onOpenChange,
}: BuildRouteConfirmProps) {
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
      onOpenChange();
    });
    (next ? questionRef : buttonRef).current?.focus();
  }

  return (
    <div className="round-build-route">
      {open ? (
        <div role="group" aria-labelledby={questionId} className="cancel-confirm">
          {/* tabIndex -1: focusable from code, but not a stop when tabbing through the page. */}
          <p id={questionId} ref={questionRef} tabIndex={-1} className="cancel-confirm-question">
            {question}
          </p>
          {failed && (
            <p className="form-alert" role="alert">
              {BUILD_ROUTE_FAILED_MESSAGE}
            </p>
          )}
          <div className="cancel-confirm-actions">
            {/* aria-disabled, not disabled, while building: the button keeps focus and is
                announced as unavailable; the screen's guard ignores the extra taps. */}
            <button
              type="button"
              className="button button-primary"
              aria-disabled={building ? true : undefined}
              onClick={onBuild}
            >
              {building ? BUILDING_ROUTE_LABEL : BUILD_ROUTE_YES_LABEL}
            </button>
            <button
              type="button"
              className="button button-secondary"
              aria-disabled={building ? true : undefined}
              onClick={() => {
                // While the build is on its way its answer decides; closing now would hide it.
                if (!building) showQuestion(false);
              }}
            >
              {BUILD_ROUTE_NO_LABEL}
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className="button button-primary button-block"
          onClick={() => showQuestion(true)}
        >
          {BUILD_ROUTE_LABEL}
        </button>
      )}
    </div>
  );
}
