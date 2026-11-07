// "התחל מסלול", the last step of a round before its route (spec §3.6): a button, and once tapped
// a question in the page that says how many customers the route will take in. The rounds
// screen (RoundsScreen.tsx) sends the build itself and tells this component whether it is on its
// way and whether it failed; this component owns only the question being open and the focus.
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/** The button at the end of a round in step 1 (spec §3.6). */
export const BUILD_ROUTE_LABEL = 'התחל מסלול';
/** "Yes" of the question: builds the route. */
export const BUILD_ROUTE_YES_LABEL = 'כן, להתחיל';
/** "No" of the question: back to the button, nothing sent. */
export const BUILD_ROUTE_NO_LABEL = 'לא, עוד לא';
/** "Yes" while the build is on its way. */
export const BUILDING_ROUTE_LABEL = 'מתחיל מסלול...';

/** Inside the question when the build got no usable answer; "כן" can be tapped again. */
export const BUILD_ROUTE_FAILED_MESSAGE = 'לא הצלחנו להתחיל את המסלול. נא לנסות שוב.';

/**
 * The question "התחל מסלול" asks first, in plain words: how many customers the route takes in.
 * Nobody is left out for not answering (ADR-0012): every customer still in the round is a stop, so
 * `inRoundCount` is the size of the "בסבב" group. The route is computed once, so Yoel builds it
 * when the customers who are not coming have had their chance to say so.
 *
 * With none in the round (everyone asked for another date or cancelled) it says the route is
 * empty; building it is harmless.
 */
export function buildRouteQuestion(inRoundCount: number): string {
  const question = 'להתחיל מסלול?';
  if (inRoundCount === 0) return `אין לקוחות בסבב, המסלול יהיה ריק. ${question}`;
  if (inRoundCount === 1) return `המסלול יכלול לקוח אחד. ${question}`;
  return `המסלול יכלול ${inRoundCount} לקוחות. ${question}`;
}

/**
 * What the rounds screen tells a step-1 section about its build, and how the section reaches back;
 * the screen sends the request.
 */
export interface BuildRouteControl {
  /** True while the build is on its way ("מתחיל מסלול..."). */
  building: boolean;
  /** True when the last build got no usable answer. */
  failed: boolean;
  /** "כן, להתחיל". Called on every tap, a busy one too: the screen keeps its own guard. */
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
 * "התחל מסלול" and, once tapped, its question in its place, with
 * "כן, להתחיל" and "לא, עוד לא" under it. Built like components/CancelConfirm.tsx, whose
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
