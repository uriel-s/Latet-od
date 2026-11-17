// One stop of the route screen (spec §3.6 step 2, "מסלול"): who, where, how many bottles, and
// what Yoel does there: "נווט" (Waze), "חייג", "הודעה" (WhatsApp), "אספתי" in one tap (the api
// keeps the estimate as the count), and "⋯", which opens the bottom sheet with "לא נמצא" and the
// arrows that move the stop. A handled stop shows its state in words and, once collected, its
// "שלח תודה" row (SendList.tsx, which stores the opening itself through useApi).
// Presentational: the route screen sends every stop request and tells this card whether one is on
// its way and why it failed; the card owns only its "⋯" sheet and where focus goes.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { waMeChatUrl, type RouteStopView } from '@bottlerun/shared';
import { Icon } from '../components/Icon.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { bottlesText } from './countText.ts';
import { MoreActionsSheet } from './MoreActionsSheet.tsx';
import { NO_LOCATION_TAG } from './orderTags.ts';
import {
  STOP_STATE_LABELS,
  isStopHandled,
  stopAddressLines,
  telUrl,
  wazeUrl,
} from './routeStops.ts';
import { SendList } from './SendList.tsx';

/** The eyebrow of the current stop's card (the first stop still to collect). */
export const NEXT_STOP_EYEBROW = 'העצירה הבאה';

/** Above the thank-you's "שלח" row of a collected stop. */
export const SEND_THANKS_TITLE = 'שלח תודה';

/** How long the current card's "אספתי" ignores taps after the card appears. */
export const COLLECT_TAP_GUARD_MS = 1000;

/** Props of {@link StopCard}. */
export interface StopCardProps {
  stop: RouteStopView;
  /** 1-based position in the visible list: the number in the timeline dot of an upcoming stop. */
  position: number;
  /**
   * The route's next stop to collect: shown as the big "העצירה הבאה" card (icon, tags, "נווט" /
   * "חייג" / "הודעה" / "⋯", a big "אספתי"). Ignored for a handled stop. Default false: the
   * compact timeline card of an upcoming stop, whose "⋯" sheet also holds "אספתי", "נווט",
   * "חייג" and "הודעה".
   */
  current?: boolean;
  /** The current card's name `<h3>`: the route screen focuses it after a saved "אספתי". */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** Whether the "הזז למעלה" arrow shows (the route screen's storedMovesFor(...) > 0). */
  canMoveUp: boolean;
  /** Whether the "הזז למטה" arrow shows. */
  canMoveDown: boolean;
  /** An action of this card is on its way: buttons aria-disabled, the tap does nothing. */
  busy: boolean;
  /** Why the last action of this card failed (plain Hebrew), shown in the card; undefined for none. */
  error?: string;
  onMove: (direction: 'up' | 'down') => void;
  /** "אספתי", on the current card or in the compact card's sheet. */
  onCollect: () => void;
  /** "כן, לא נמצא" in the card's question. */
  onNotFound: () => void;
  /**
   * What the route screen just saved for this card: 'collected' (Yoel's own "אספתי") buzzes once;
   * 'notFound' (his own "כן, לא נמצא") moves the focus to the handled card's name; 'moved' (an
   * arrow) puts a lost focus back on "⋯". It comes from the screen, not from a flag inside the
   * card, because the save moves the card into another list (current → handled, current ↔
   * upcoming), and React mounts a new card there.
   */
  justSaved?: JustSaved;
  /** The card acted on `justSaved`: the screen forgets it, so it happens once. */
  onJustSavedSeen?: () => void;
}

/** A save of the route screen that the card reacts to; see {@link StopCardProps.justSaved}. */
export type JustSaved = 'collected' | 'notFound' | 'moved';

/**
 * One stop as a list item; the route screen puts the cards in an `<ol>` under the round's `<h2>`,
 * so the customer's name is the card's `<h3>`.
 *
 * Still to collect, the current one: the full address (street and number; where the bottles are,
 * with the floor and apartment; the note), the estimated bottles, "בלי מיקום" by the STORED flag
 * (`stop.hasLocation`, from when the route was built), and the buttons. Every button's hidden rest
 * names the customer, so a screen reader's list of buttons tells the cards apart; the visible
 * words start the name, as WCAG 2.5.3 (label in name) asks.
 *
 * Still to collect, an upcoming one (`current` false): a compact timeline card with a numbered dot,
 * the name, the street, the estimate or "בלי מיקום", and "⋯", whose sheet has every action.
 *
 * Handled (any other state): coloured, with its state in words, the name and the street, and no
 * action; when collected, its "שלח תודה" row. The route screen moves it to the end of the list.
 */
export function StopCard(props: StopCardProps) {
  const { stop, justSaved } = props;
  const [moreOpen, setMoreOpen] = useState(false);
  const handled = isStopHandled(stop.state);
  // The sheet closes by itself once the stop is handled (the saved view, or a reload that shows
  // it handled elsewhere): the handled card has none. Set during render, React's pattern for state
  // that follows a prop, so no frame shows the stale sheet.
  if (handled && moreOpen) setMoreOpen(false);

  // The latest callback, read by the effects below, so a new arrow from the screen on every
  // render is not missed.
  const onJustSavedSeenRef = useRef(props.onJustSavedSeen);
  useEffect(() => {
    onJustSavedSeenRef.current = props.onJustSavedSeen;
  });

  // Yoel's own "אספתי" was saved (the screen says so in justSaved, and the stop shows collected):
  // a short buzz, so he feels it went through without looking. A stop collected elsewhere or seen
  // collected on a reload does not. navigator.vibrate is missing on iOS and desktop: optional call.
  const collectedHere = justSaved === 'collected' && stop.state === 'collected';
  useEffect(() => {
    if (!collectedHere) return;
    navigator.vibrate?.(30);
    onJustSavedSeenRef.current?.();
  }, [collectedHere]);
  // Yoel's own "כן, לא נמצא" was saved: the sheet he answered in is gone with the card it was in,
  // and the focus would fall to the page. The handled card's name takes it, so a screen reader
  // says which stop moved and he goes on from there. A stop seen not found on a reload does not.
  const nameRef = useRef<HTMLHeadingElement>(null);
  const notFoundHere = justSaved === 'notFound' && stop.state === 'notFound';
  useEffect(() => {
    if (!notFoundHere) return;
    nameRef.current?.focus();
    onJustSavedSeenRef.current?.();
  }, [notFoundHere]);
  // An arrow's move was saved. Focus that was on this card's "⋯" is lost when the move took the
  // card into the other list; put it back on the new "⋯", but never take it from somewhere else.
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const movedHere = justSaved === 'moved' && !handled;
  useEffect(() => {
    if (!movedHere) return;
    const active = document.activeElement;
    if (active === null || active === document.body) moreButtonRef.current?.focus();
    onJustSavedSeenRef.current?.();
  }, [movedHere]);

  if (handled) {
    return <HandledStopCard {...props} nameRef={nameRef} />;
  }
  return (
    <ToCollectStopCard
      {...props}
      moreOpen={moreOpen}
      setMoreOpen={setMoreOpen}
      moreButtonRef={moreButtonRef}
    />
  );
}

/** Props of {@link ToCollectStopCard}: the card's, plus its "⋯" sheet and button. */
interface ToCollectStopCardProps extends StopCardProps {
  moreOpen: boolean;
  setMoreOpen: (open: boolean) => void;
  /** Owned by StopCard, which focuses "⋯" after a saved move. */
  moreButtonRef: RefObject<HTMLButtonElement | null>;
}

/** A stop Yoel has yet to stop at; see {@link StopCard}. */
function ToCollectStopCard({
  stop,
  position,
  current = false,
  headingRef,
  canMoveUp,
  canMoveDown,
  busy,
  error,
  onMove,
  onCollect,
  onNotFound,
  moreOpen,
  setMoreOpen,
  moreButtonRef,
}: ToCollectStopCardProps) {
  const { order } = stop;
  const name = order.contact.name;
  const lines = stopAddressLines(order.address);

  // Collected is final, and after one "אספתי" the next stop's button lands right where the finger
  // just was: a tap in the first COLLECT_TAP_GUARD_MS after the card appears is a double tap.
  const shownAtRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    shownAtRef.current = Date.now();
  }, []);

  function collectFromCard(): void {
    const shownAt = shownAtRef.current;
    if (busy || shownAt === undefined || Date.now() - shownAt < COLLECT_TAP_GUARD_MS) return;
    onCollect();
  }

  /** Closes the sheet; the focus goes back to the "⋯" that opened it. */
  function closeSheet(): void {
    setMoreOpen(false);
    moreButtonRef.current?.focus();
  }

  // aria-disabled, not disabled, while busy: a button keeps focus and is announced as
  // unavailable, and its tap does nothing (the screen keeps its own guard too).
  const ariaBusy = busy ? true : undefined;
  const nameSuffix = <span className="visually-hidden">, {name}</span>;

  // While the sheet is open its error shows inside it: in the card it would sit behind the dark
  // background, outside the modal dialog a screen reader stays in. Closed, the card shows it.
  const cardError = moreOpen ? undefined : error;
  const moreSheet = moreOpen && (
    <MoreActionsSheet
      name={name}
      canMoveUp={canMoveUp}
      canMoveDown={canMoveDown}
      busy={busy}
      error={error}
      onMove={onMove}
      onNotFound={onNotFound}
      // Only the compact card: its sheet is where "אספתי", "נווט", "חייג" and "הודעה" live.
      {...(current
        ? {}
        : {
            onCollect: () => {
              closeSheet();
              onCollect();
            },
            navigateUrl: wazeUrl(order.address),
            phoneUrl: telUrl(order.contact.phone),
            messageUrl: waMeChatUrl(order.contact.phone),
          })}
      onClose={closeSheet}
    />
  );

  // "⋯": opens the sheet; aria-haspopup tells a screen reader it is a dialog.
  const moreButton = (
    <button
      ref={moreButtonRef}
      type="button"
      className="button button-secondary"
      aria-haspopup="dialog"
      aria-expanded={moreOpen}
      aria-disabled={ariaBusy}
      aria-label={`עוד פעולות, ${name}`}
      onClick={() => {
        if (!busy) setMoreOpen(true);
      }}
    >
      <Icon name="more" />
    </button>
  );

  if (current) {
    return (
      <li className="stop-card stop-card-current">
        <div className="stop-card-current-top">
          <span className="stop-card-avatar" aria-hidden="true">
            <Icon name="bottle" />
          </span>
          <div>
            <p className="stop-card-eyebrow">{NEXT_STOP_EYEBROW}</p>
            {/* tabIndex -1: focused from code after "אספתי" saved, never a Tab stop. */}
            <h3 ref={headingRef} tabIndex={-1} className="stop-card-name">
              {name}
            </h3>
          </div>
        </div>
        <div className="stop-card-fact">
          <Icon name="pin" />
          <div>
            <p className="stop-card-street">{lines.street}</p>
            <p className="stop-card-spot">{lines.spot}</p>
            {lines.note !== undefined && <p className="stop-card-note">הערה: {lines.note}</p>}
          </div>
        </div>
        <p className="tag-list">
          <span className="tag">{bottlesText(order.bottlesEstimated)}</span>
          <StatusBadge status={order.status} />
          {!stop.hasLocation && <span className="tag">{NO_LOCATION_TAG}</span>}
        </p>

        <div className="stop-card-current-row">
          {/* The same Waze link as the plain card's "נווט" (ADR-0007): it follows the current
              stop, so after "אספתי" it points at the next one. */}
          <a
            className="button button-secondary"
            href={wazeUrl(order.address)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="navigate" />
            נווט{nameSuffix}
          </a>
          <a className="button button-secondary" href={telUrl(order.contact.phone)}>
            <Icon name="phone" />
            חייג{nameSuffix}
          </a>
          {/* An empty WhatsApp chat, as the orders tab's "הודעה": Yoel writes what he needs. */}
          <a
            className="button button-secondary"
            href={waMeChatUrl(order.contact.phone)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="chat" />
            הודעה{nameSuffix}
          </a>
          {moreButton}
        </div>
        <button
          type="button"
          className="button button-primary button-big button-block"
          aria-disabled={ariaBusy}
          onClick={collectFromCard}
        >
          <Icon name="check" />
          אספתי{nameSuffix}
        </button>

        {moreSheet}

        {cardError !== undefined && (
          <p className="field-error" role="alert">
            {cardError}
          </p>
        )}
      </li>
    );
  }

  // An upcoming stop: a numbered dot on the timeline and a compact card. Everything else
  // ("אספתי", "נווט", "חייג", "הודעה", "לא נמצא", the arrows) is in the "⋯" sheet.
  return (
    <li className="stop-card stop-card-compact">
      <span className="timeline-dot" aria-hidden="true">
        {position}
      </span>
      <div className="stop-card-compact-body">
        <h3 className="stop-card-name">{name}</h3>
        <p className="stop-card-street">{lines.street}</p>
        <p className="tag-list">
          <span className="tag">{bottlesText(order.bottlesEstimated)}</span>
          {!stop.hasLocation && <span className="tag">{NO_LOCATION_TAG}</span>}
        </p>
      </div>
      {moreButton}

      {moreSheet}

      {cardError !== undefined && (
        <p className="field-error stop-card-compact-wide" role="alert">
          {cardError}
        </p>
      )}
    </li>
  );
}

/** Props of {@link HandledStopCard}: the card's, plus the name StopCard focuses. */
interface HandledStopCardProps extends StopCardProps {
  /** The name, focused after Yoel's own "כן, לא נמצא" saved. */
  nameRef: RefObject<HTMLHeadingElement | null>;
}

/**
 * A stop with nothing left to do: its state as a badge in words (the colour is never the only
 * signal), the name and the street, and no action or arrow. A collected stop with a thank-you to
 * send shows its "שלח תודה" row; SendList keeps what Yoel tapped while the row stays mounted.
 */
function HandledStopCard({ stop, error, nameRef }: HandledStopCardProps) {
  const { order } = stop;
  // isStopHandled already excluded 'toCollect'; the check narrows the type for the label lookup.
  const label = stop.state === 'toCollect' ? undefined : STOP_STATE_LABELS[stop.state];

  return (
    <li className="stop-card stop-card-handled">
      {/* tabIndex -1: focused from code after "כן, לא נמצא" saved, never a Tab stop. */}
      <h3 ref={nameRef} tabIndex={-1} className="stop-card-name">
        {order.contact.name}
      </h3>
      <p className="stop-card-state">{label}</p>
      <p className="stop-card-street">{stopAddressLines(order.address).street}</p>
      {stop.state === 'collected' && stop.thankYou !== undefined && (
        <div className="stop-card-thanks">
          <h4 className="stop-card-thanks-title">{SEND_THANKS_TITLE}</h4>
          <SendList rows={[stop.thankYou]} />
        </div>
      )}
      {error !== undefined && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
