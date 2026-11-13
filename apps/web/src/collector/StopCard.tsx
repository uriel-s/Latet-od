// One stop of the route screen (spec §3.6 step 2, "מסלול"): who, where, how many bottles, and
// what Yoel does there: "נווט" (Waze), "חייג", "אספתי" with the real quantity (a − / + stepper),
// and "⋯", which opens the bottom sheet with "לא נמצא" and the arrows that move the stop. A handled stop shows its state in words and, once
// collected, its "שלח תודה" row (SendList.tsx, which stores the opening itself through useApi).
// Presentational: the route screen sends every stop request and tells this card whether one is on
// its way and why it failed; the card owns only what is open in it (the quantity stepper, the "⋯"
// sheet) and where focus goes.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  COLLECT_STOP_ERRORS,
  MAX_BOTTLES,
  collectStopRequestSchema,
  type RouteStopView,
} from '@bottlerun/shared';
import { Icon } from '../components/Icon.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TextField } from '../components/TextField.tsx';
import { MoreActionsSheet } from './MoreActionsSheet.tsx';
import { bottlesText } from './OrdersScreen.tsx';
import { NO_LOCATION_TAG } from './orderTags.ts';
import {
  STOP_STATE_LABELS,
  isStopHandled,
  stopAddressLines,
  telUrl,
  wazeUrl,
} from './routeStops.ts';
import { SendList } from './SendList.tsx';

/** The label of the quantity field "אספתי" opens. */
export const BOTTLES_COLLECTED_LABEL = 'כמה בקבוקים נאספו';

/** The eyebrow of the current stop's card (the first stop still to collect). */
export const NEXT_STOP_EYEBROW = 'העצירה הבאה';

/** Above the thank-you's "שלח" row of a collected stop. */
export const SEND_THANKS_TITLE = 'שלח תודה';

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

/** Props of {@link StopCard}. */
export interface StopCardProps {
  stop: RouteStopView;
  /** 1-based position in the visible list: the number in the timeline dot of an upcoming stop. */
  position: number;
  /**
   * The route's next stop to collect: shown as the big "העצירה הבאה" card (icon, tags, "נווט" /
   * "חייג" / "⋯", a big "אספתי"). Ignored for a handled stop. Default false: the compact
   * timeline card of an upcoming stop, whose "⋯" sheet also holds "אספתי", "נווט" and "חייג".
   */
  current?: boolean;
  /** Whether the "הזז למעלה" arrow shows (the route screen's storedMovesFor(...) > 0). */
  canMoveUp: boolean;
  /** Whether the "הזז למטה" arrow shows. */
  canMoveDown: boolean;
  /** An action of this card is on its way: buttons aria-disabled, the tap does nothing. */
  busy: boolean;
  /** Why the last action of this card failed (plain Hebrew), shown in the card; undefined for none. */
  error?: string;
  /** The api's message for the quantity (400 invalid_collect), shown next to the field. */
  bottlesError?: string;
  onMove: (direction: 'up' | 'down') => void;
  /** "שמור" in the quantity field, with a validated whole number. */
  onCollect: (bottlesCollected: number) => void;
  /** "כן, לא נמצא" in the card's question. */
  onNotFound: () => void;
  /** The quantity field opened or closed: the screen stops reload-on-return while Yoel types. */
  onTypingChange?: (typing: boolean) => void;
  /**
   * What the route screen just saved for this card: 'collected' (Yoel's own "אספתי") buzzes once
   * and moves the focus to "שלח תודה"; 'notFound' (his own "כן, לא נמצא") moves it to the handled
   * card's name; 'moved' (an arrow) puts a lost focus back on "⋯". It comes
   * from the screen, not from a flag inside the card, because the save moves the card into another
   * list (current → handled, current ↔ upcoming), and React mounts a new card there.
   */
  justSaved?: JustSaved;
  /** The card acted on `justSaved`: the screen forgets it, so it happens once. */
  onJustSavedSeen?: () => void;
}

/** A save of the route screen that the card reacts to; see {@link StopCardProps.justSaved}. */
export type JustSaved = 'collected' | 'notFound' | 'moved';

/** What is open in a card still to collect: nothing, the quantity stepper, or the "⋯" sheet. */
type OpenPart = 'none' | 'quantity' | 'more';

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
  const { stop, onTypingChange, justSaved } = props;
  const [openPart, setOpenPart] = useState<OpenPart>('none');
  const handled = isStopHandled(stop.state);
  // The field and the sheet close by themselves once the stop is handled (the saved view, or
  // a reload that shows it handled elsewhere): the handled card has neither. Set during render,
  // React's pattern for state that follows a prop, so no frame shows the stale part.
  if (handled && openPart !== 'none') setOpenPart('none');
  const typing = openPart === 'quantity' && !handled;

  // The latest callback, read by the effects below, so a new arrow from the screen on every
  // render neither reports "typing" again nor is missed on unmount.
  const onTypingChangeRef = useRef(onTypingChange);
  const onJustSavedSeenRef = useRef(props.onJustSavedSeen);
  useEffect(() => {
    onTypingChangeRef.current = onTypingChange;
    onJustSavedSeenRef.current = props.onJustSavedSeen;
  });
  // What the screen was last told, so it hears each change once (StrictMode's second run too).
  const reportedTypingRef = useRef(false);
  useEffect(() => {
    if (reportedTypingRef.current === typing) return;
    reportedTypingRef.current = typing;
    onTypingChangeRef.current?.(typing);
  }, [typing]);
  // A card that leaves the screen with its field open must not keep the screen's reload stopped.
  useEffect(
    () => () => {
      if (!reportedTypingRef.current) return;
      reportedTypingRef.current = false;
      onTypingChangeRef.current?.(false);
    },
    [],
  );

  // Yoel's own "אספתי" was saved (the screen says so in justSaved, and the stop shows collected).
  // A stop collected elsewhere or seen collected on a reload does neither of the two below.
  const thanksTitleRef = useRef<HTMLHeadingElement>(null);
  const collectedHere = justSaved === 'collected' && stop.state === 'collected';
  // A short buzz, so he feels it went through without looking. navigator.vibrate is missing on
  // iOS and desktop: optional call.
  useEffect(() => {
    if (collectedHere) navigator.vibrate?.(30);
  }, [collectedHere]);
  // The thank-you row's title gets the focus: the field he typed in is gone, and the row he taps
  // next ("שלח") is right under it, in the handled list the card moved to.
  const showThanks = stop.state === 'collected' && stop.thankYou !== undefined;
  useEffect(() => {
    if (!collectedHere || !showThanks) return;
    thanksTitleRef.current?.focus();
    onJustSavedSeenRef.current?.();
  }, [collectedHere, showThanks]);
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
    return <HandledStopCard {...props} nameRef={nameRef} thanksTitleRef={thanksTitleRef} />;
  }
  return (
    <ToCollectStopCard
      {...props}
      openPart={openPart}
      setOpenPart={setOpenPart}
      moreButtonRef={moreButtonRef}
    />
  );
}

/** Props of {@link ToCollectStopCard}: the card's, plus what is open in it and its "⋯" button. */
interface ToCollectStopCardProps extends StopCardProps {
  openPart: OpenPart;
  setOpenPart: (part: OpenPart) => void;
  /** Owned by StopCard, which focuses "⋯" after a saved move. */
  moreButtonRef: RefObject<HTMLButtonElement | null>;
}

/** A stop Yoel has yet to stop at; see {@link StopCard}. */
function ToCollectStopCard({
  stop,
  position,
  current = false,
  canMoveUp,
  canMoveDown,
  busy,
  error,
  bottlesError,
  onMove,
  onCollect,
  onNotFound,
  openPart,
  setOpenPart,
  moreButtonRef,
}: ToCollectStopCardProps) {
  const { order } = stop;
  const name = order.contact.name;
  const lines = stopAddressLines(order.address);
  const [quantity, setQuantity] = useState('');
  const [quantityError, setQuantityError] = useState<string | undefined>(undefined);
  const collectButtonRef = useRef<HTMLButtonElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);

  /**
   * Opens or closes a part of the card. flushSync renders first, so the element to focus exists,
   * and the focus call stays inside the tap: to the quantity field when it opens (the button just
   * tapped is gone; the sheet takes its own focus), and back to the button that opened the part
   * when it closes.
   */
  function open(part: OpenPart): void {
    const closing = openPart;
    flushSync(() => {
      setOpenPart(part);
      if (part === 'quantity') {
        // The estimate is the default: most of the time Yoel only taps "שמור".
        setQuantity(String(order.bottlesEstimated));
        setQuantityError(undefined);
      }
    });
    if (part === 'quantity') {
      quantityInputRef.current?.focus();
      // Selected, so typing the real count replaces the estimate instead of adding to it.
      quantityInputRef.current?.select();
    } else if (part === 'none') {
      // The compact card has no "אספתי" of its own: focus goes back to its "⋯".
      (closing === 'more' || !current ? moreButtonRef : collectButtonRef).current?.focus();
    }
  }

  /** The − / + buttons: one bottle at a time, never below 1 or above what the api accepts. */
  function step(delta: 1 | -1): void {
    const typed = quantity.trim();
    // A blank or half-typed field steps from the estimate, so the buttons always do something.
    const base = /^\d+$/.test(typed) ? Number(typed) : order.bottlesEstimated;
    setQuantity(String(Math.min(MAX_BOTTLES, Math.max(1, base + delta))));
    setQuantityError(undefined);
  }

  function save(): void {
    if (busy) return;
    const result = parseBottlesCollected(quantity);
    if (!result.ok) {
      setQuantityError(result.message);
      quantityInputRef.current?.focus();
      return;
    }
    setQuantityError(undefined);
    onCollect(result.bottlesCollected);
  }

  // aria-disabled, not disabled, while busy: a button keeps focus and is announced as
  // unavailable, and its tap does nothing (the screen keeps its own guard too).
  const ariaBusy = busy ? true : undefined;
  const nameSuffix = <span className="visually-hidden">, {name}</span>;
  const moreOpen = openPart === 'more';
  const quantityOpen = openPart === 'quantity';

  // Shared by the plain card and the current one: the quantity stepper (the "⋯" sheet follows).
  const quantityPanel = quantityOpen && (
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
          inputRef={quantityInputRef}
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
            if (!busy) open('none');
          }}
        >
          ביטול
        </button>
      </div>
    </form>
  );

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
      // Only the compact card: its sheet is where "אספתי", "נווט" and "חייג" live.
      {...(current
        ? {}
        : {
            onCollect: () => open('quantity'),
            navigateUrl: wazeUrl(order.address),
            phoneUrl: telUrl(order.contact.phone),
          })}
      onClose={() => open('none')}
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
        if (!busy) open('more');
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
            <h3 className="stop-card-name">{name}</h3>
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

        {quantityPanel}

        {!quantityOpen && (
          <>
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
              {moreButton}
            </div>
            <button
              ref={collectButtonRef}
              type="button"
              className="button button-primary button-big button-block"
              aria-disabled={ariaBusy}
              onClick={() => {
                if (!busy) open('quantity');
              }}
            >
              <Icon name="check" />
              אספתי{nameSuffix}
            </button>
          </>
        )}

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
  // ("אספתי", "נווט", "חייג", "לא נמצא", the arrows) is in the "⋯" sheet.
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

      {quantityOpen && <div className="stop-card-compact-wide">{quantityPanel}</div>}

      {moreSheet}

      {cardError !== undefined && (
        <p className="field-error stop-card-compact-wide" role="alert">
          {cardError}
        </p>
      )}
    </li>
  );
}

/** Props of {@link HandledStopCard}: the card's, plus the headings StopCard focuses. */
interface HandledStopCardProps extends StopCardProps {
  /** The name, focused after Yoel's own "כן, לא נמצא" saved. */
  nameRef: RefObject<HTMLHeadingElement | null>;
  /** "שלח תודה", focused after Yoel's own "אספתי" saved. */
  thanksTitleRef: RefObject<HTMLHeadingElement | null>;
}

/**
 * A stop with nothing left to do: its state as a badge in words (the colour is never the only
 * signal), the name and the street, and no action or arrow. A collected stop with a thank-you to
 * send shows its "שלח תודה" row; SendList keeps what Yoel tapped while the row stays mounted.
 */
function HandledStopCard({ stop, error, nameRef, thanksTitleRef }: HandledStopCardProps) {
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
          {/* tabIndex -1: focused from code after "אספתי" saved, never a Tab stop. */}
          <h4 ref={thanksTitleRef} tabIndex={-1} className="stop-card-thanks-title">
            {SEND_THANKS_TITLE}
          </h4>
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
