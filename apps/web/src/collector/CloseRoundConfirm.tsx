// The close button of an open round (spec §3.6), in both of its phases ("סיימתי את הסבב" once
// routed, "בטל את הסבב" while confirming): a button, and once tapped a
// question in the page that says what closing does, with the "תודות שלא נשלחו" list above it, so
// Yoel can still send a thank-you he forgot before the round leaves his screen. The rounds screen
// sends the close itself and tells this component whether it is on its way and whether it failed;
// this component owns only the question being open, the rows it shows, and where the focus goes.
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { MessageLink, RoundPhase, RoundView } from '@bottlerun/shared';
import { SendList, type SendListProps } from './SendList.tsx';

/** The texts of the close button and its question for one {@link RoundPhase}. */
export interface CloseRoundTexts {
  /** The button that opens the question. */
  label: string;
  /** The last sentence of the question, after the count of customers who go back to waiting. */
  question: string;
  /** "Yes" of the question: closes the round. */
  yesLabel: string;
  /** "Yes" while the close is on its way. */
  busyLabel: string;
  /** Inside the question when the close got no usable answer; "כן" can be tapped again. */
  failedMessage: string;
}

/**
 * The close texts by phase. The same api call means two different things to Yoel: once the route
 * is built (`routed`) he is done with the drive, and whatever he did not collect goes back to
 * waiting ("סיימתי את הסבב"); while the round is still `confirming` there is no drive yet, so
 * closing calls the whole round off, e.g. for rain ("בטל את הסבב"). One label cannot be right for
 * both, so the wording follows `view.round.phase`.
 */
export const CLOSE_ROUND_TEXTS: Record<RoundPhase, CloseRoundTexts> = {
  routed: {
    label: 'סיימתי את הסבב',
    question: 'לסיים את הסבב?',
    yesLabel: 'כן, לסיים',
    busyLabel: 'מסיים סבב...',
    failedMessage: 'לא הצלחנו לסיים את הסבב. נא לנסות שוב.',
  },
  confirming: {
    label: 'בטל את הסבב',
    question: 'לבטל את הסבב?',
    yesLabel: 'כן, לבטל את הסבב',
    busyLabel: 'מבטל סבב...',
    failedMessage: 'לא הצלחנו לבטל את הסבב. נא לנסות שוב.',
  },
};

/** "No" of the question, in both phases: back to the button, nothing sent. */
export const CLOSE_ROUND_NO_LABEL = 'לא, עוד לא';

/** Heading of the thank-yous Yoel has not opened yet; shown only when there is one. */
export const UNSENT_THANK_YOUS_TITLE = 'תודות שלא נשלחו';
/** Under {@link UNSENT_THANK_YOUS_TITLE}: why the list is here. */
export const UNSENT_THANK_YOUS_HINT = 'כדאי לשלוח אותן לפני שמסיימים את הסבב.';

/**
 * The thank-yous of `view` that Yoel has not opened yet, in the route's stored order: the
 * `thankYou` of each `collected` stop that has one with no `openedAt` (roundsApi.ts,
 * routeStopViewSchema). A stop in any other state never has a `thankYou`; the state is checked
 * anyway, so an odd view cannot list one.
 */
export function unsentThankYous(view: RoundView): MessageLink[] {
  return view.stops.flatMap((stop) =>
    stop.state === 'collected' &&
    stop.thankYou !== undefined &&
    stop.thankYou.openedAt === undefined
      ? [stop.thankYou]
      : [],
  );
}

/**
 * How many orders closing `view`'s round sends back to waiting (spec §3.6; the api's
 * closeRound.ts does the same):
 * - phase `confirming` (e.g. a round called off for rain): every order still in the round, i.e.
 *   the "אישרו" and "עוד לא אישרו" groups. Counted by status, `confirmed` or `pending`, since the
 *   "אישרו" group also holds `collected` orders (roundGroupOf), which a closed round keeps.
 * - phase `routed`: the stops still `toCollect`; collected, not found, cancelled and left stops
 *   are already handled.
 */
export function ordersSentBackCount(view: RoundView): number {
  if (view.round.phase === 'routed') {
    return view.stops.filter((stop) => stop.state === 'toCollect').length;
  }
  return view.groups
    .filter((group) => group.key === 'confirmed' || group.key === 'pending')
    .flatMap((group) => group.orders)
    .filter((order) => order.status === 'confirmed' || order.status === 'pending').length;
}

/**
 * The question the close button asks first, in plain words like buildRouteQuestion
 * (BuildRouteConfirm.tsx): how many customers go back to waiting for the next round, so Yoel hears
 * it before he decides.
 * In phase `routed` they are the stops he has not collected from yet, and it says so; in phase
 * `confirming` it is everyone still in the round.
 */
export function closeRoundQuestion(sentBackCount: number, phase: RoundPhase): string {
  const question = CLOSE_ROUND_TEXTS[phase].question;
  if (sentBackCount === 0) return `אף לקוח לא יחזור לחכות. ${question}`;
  if (phase === 'routed') {
    if (sentBackCount === 1) {
      return `לקוח אחד שעוד לא אספנו ממנו יחזור לחכות לסבב הבא. ${question}`;
    }
    return `${sentBackCount} לקוחות שעוד לא אספנו מהם יחזרו לחכות לסבב הבא. ${question}`;
  }
  if (sentBackCount === 1) return `לקוח אחד יחזור לחכות לסבב הבא. ${question}`;
  return `${sentBackCount} לקוחות יחזרו לחכות לסבב הבא. ${question}`;
}

/** Props of {@link CloseRoundConfirm}. */
export interface CloseRoundConfirmProps {
  /** The round as shown now; the question's count and the thank-you rows come from it. */
  view: RoundView;
  /** True while the close is on its way: "כן" reads the phase's `busyLabel`. */
  closing: boolean;
  /** True when the last close got no usable answer: the phase's `failedMessage`. */
  failed: boolean;
  /**
   * The "yes" of the question ("כן, לסיים" / "כן, לבטל את הסבב"). Called on every tap, a busy one too: the screen keeps its own guard, so
   * a double tap sends one request.
   */
  onClose: () => void;
  /** The question opened or closed; the screen clears an old error here. */
  onOpenChange: () => void;
  /** Passed to the thank-you rows; undefined keeps SendList's own default (the api). */
  markOpened?: SendListProps['markOpened'];
}

/**
 * The close button and, once tapped, its question in its place; the wording follows the round's
 * phase ({@link CLOSE_ROUND_TEXTS}). Built like BuildRouteConfirm.tsx and
 * components/CancelConfirm.tsx: a question in the page, not
 * `window.confirm`, and the focus where the next step is. The button is the quiet outline style,
 * so it does not compete with the round's main step ("התחל מסלול", or the route).
 *
 * The open question is one group, named by the question, top to bottom: the
 * "תודות שלא נשלחו" list (only when there is one), the question, the error of a failed close, and
 * "כן" / "לא". On opening, the focus goes to the first thing in it: the list's heading when the
 * list shows, since Yoel should see the unsent thank-yous before he answers (and the focus also
 * scrolls the top of the group into view), else the question. "לא, עוד לא" puts it back on the
 * button.
 *
 * The rows must not vanish under Yoel's finger. Tapping "שלח" sends him to WhatsApp, and coming
 * back reloads the round, whose row then has `openedAt` and drops out of {@link unsentThankYous}.
 * So the order ids of the unsent rows are kept from when the question opened, and while it is
 * open those rows stay, with the current view's link (its `openedAt` shows as "נפתח ✓"), together
 * with any row unsent now, all in the route's order. Closing the question forgets them.
 */
export function CloseRoundConfirm({
  view,
  closing,
  failed,
  onClose,
  onOpenChange,
  markOpened,
}: CloseRoundConfirmProps) {
  // The order ids of the rows unsent when the question opened; undefined while it is closed.
  const [keptOrderIds, setKeptOrderIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const open = keptOrderIds !== undefined;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const questionId = useId();
  const texts = CLOSE_ROUND_TEXTS[view.round.phase];

  const rows = open ? thankYouRows(view, keptOrderIds) : [];

  /**
   * Opens or closes the question. flushSync renders first, so the element to focus exists, and
   * the focus call stays inside the tap.
   */
  function showQuestion(next: boolean): void {
    flushSync(() => {
      setKeptOrderIds(next ? new Set(unsentThankYous(view).map((row) => row.orderId)) : undefined);
      onOpenChange();
    });
    if (!next) buttonRef.current?.focus();
    else (headingRef.current ?? questionRef.current)?.focus();
  }

  return (
    <div className="round-close">
      {open ? (
        <div role="group" aria-labelledby={questionId} className="cancel-confirm">
          {rows.length > 0 && (
            <>
              {/* tabIndex -1: focused from code when the question opens, never a Tab stop. */}
              <h3 ref={headingRef} tabIndex={-1}>
                {UNSENT_THANK_YOUS_TITLE}
              </h3>
              <p className="round-hint">{UNSENT_THANK_YOUS_HINT}</p>
              <SendList rows={rows} markOpened={markOpened} />
            </>
          )}
          {/* tabIndex -1: focusable from code, but not a stop when tabbing through the page. */}
          <p id={questionId} ref={questionRef} tabIndex={-1} className="cancel-confirm-question">
            {closeRoundQuestion(ordersSentBackCount(view), view.round.phase)}
          </p>
          {failed && (
            <p className="form-alert" role="alert">
              {texts.failedMessage}
            </p>
          )}
          <div className="cancel-confirm-actions">
            {/* aria-disabled, not disabled, while closing: the button keeps focus and is
                announced as unavailable; the screen's guard ignores the extra taps. */}
            <button
              type="button"
              className="button button-primary"
              aria-disabled={closing ? true : undefined}
              onClick={onClose}
            >
              {closing ? texts.busyLabel : texts.yesLabel}
            </button>
            <button
              type="button"
              className="button button-secondary"
              aria-disabled={closing ? true : undefined}
              onClick={() => {
                // While the close is on its way its answer decides; closing now would hide it.
                if (!closing) showQuestion(false);
              }}
            >
              {CLOSE_ROUND_NO_LABEL}
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
          {texts.label}
        </button>
      )}
    </div>
  );
}

/**
 * The thank-you rows of the open question: in the route's stored order, each collected stop's
 * `thankYou` that is unsent now, or whose order was unsent when the question opened (`keptOrderIds`)
 * and is opened since, so it stays in place and shows as opened.
 */
function thankYouRows(view: RoundView, keptOrderIds: ReadonlySet<string>): MessageLink[] {
  return view.stops.flatMap((stop) => {
    const { thankYou } = stop;
    if (stop.state !== 'collected' || thankYou === undefined) return [];
    const shown = thankYou.openedAt === undefined || keptOrderIds.has(thankYou.orderId);
    return shown ? [thankYou] : [];
  });
}
