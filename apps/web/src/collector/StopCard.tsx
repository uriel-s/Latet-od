// One stop of the route screen (spec §3.6 step 2, "מסלול"): who, where, how many bottles, and
// what Yoel does there: "נווט" (Waze), "חייג", "אספתי" with the real quantity (a − / + stepper),
// and "⋯", which opens the bottom sheet with "לא נמצא" and the arrows that move the stop. A handled stop shows its state in words and, once
// collected, its "שלח תודה" row (SendList.tsx). Presentational: the route screen sends every
// request and tells this card whether one is on its way and why it failed; the card owns only
// what is open in it (the quantity stepper, the "⋯" sheet) and where focus goes.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  COLLECT_STOP_ERRORS,
  MAX_BOTTLES,
  collectStopRequestSchema,
  formatIsraeliMobileLocal,
  type RouteStopView,
} from '@bottlerun/shared';
import { Icon } from '../components/Icon.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TextField } from '../components/TextField.tsx';
import { MoreActionsSheet, NOT_FOUND_QUESTION } from './MoreActionsSheet.tsx';
import { bottlesText } from './OrdersScreen.tsx';
import { NO_LOCATION_TAG } from './orderTags.ts';
import {
  STOP_STATE_LABELS,
  isStopHandled,
  stopAddressLines,
  telUrl,
  wazeUrl,
} from './routeStops.ts';
import { SendList, type SendListProps } from './SendList.tsx';

/** The label of the quantity field "אספתי" opens. */
export const BOTTLES_COLLECTED_LABEL = 'כמה בקבוקים נאספו';

// The "לא נמצא" question moved into the sheet; re-exported so existing imports keep working.
export { NOT_FOUND_QUESTION };

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
  /** 1-based position in the visible list, shown on a stop still to collect, e.g. "עצירה 2". */
  position: number;
  /**
   * The route's next stop to collect: shown as the big "העצירה הבאה" card (icon, tags, "נווט" /
   * "חייג" / "⋯", a big "אספתי"). Ignored for a handled stop. Default false: the plain card.
   * Both have "⋯" with "לא נמצא" and the arrows in a sheet.
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
  /** Passed to the thank-you's "שלח" row; undefined keeps SendList's own default (the api). */
  markOpened?: SendListProps['markOpened'];
}

/** What is open in a card still to collect: nothing, the quantity stepper, or the "⋯" sheet. */
type OpenPart = 'none' | 'quantity' | 'more';

/**
 * One stop as a list item; the route screen puts the cards in an `<ol>` under the round's `<h2>`,
 * so the customer's name is the card's `<h3>`.
 *
 * Still to collect: "עצירה N", the name, the full address (street and number; where the bottles
 * are, with the floor and apartment; the note), the estimated bottles, "בלי מיקום" by the STORED
 * flag (`stop.hasLocation`, from when the route was built), and the buttons. Every button's
 * hidden rest names the customer, so a screen reader's list of buttons tells the cards apart; the
 * visible words start the name, as WCAG 2.5.3 (label in name) asks.
 *
 * Handled (any other state): coloured, with its state in words, the name and the street, and no
 * action; when collected, its "שלח תודה" row. The route screen moves it to the end of the list.
 */
export function StopCard(props: StopCardProps) {
  const { stop, onCollect, onTypingChange } = props;
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
  useEffect(() => {
    onTypingChangeRef.current = onTypingChange;
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

  // The thank-you row's title gets the focus when Yoel's own "אספתי" saved: the field he typed in
  // is gone, and the row he taps next ("שלח") is right under it, wherever the card moved.
  const thanksTitleRef = useRef<HTMLHeadingElement>(null);
  const savedFromHereRef = useRef(false);
  // A short buzz once Yoel's own "אספתי" is saved (the stop turned collected), so he feels it
  // went through without looking. navigator.vibrate is missing on iOS and desktop: optional call.
  const stopState = stop.state;
  useEffect(() => {
    if (stopState === 'collected' && savedFromHereRef.current) navigator.vibrate?.(30);
  }, [stopState]);
  const showThanks = stop.state === 'collected' && stop.thankYou !== undefined;
  useEffect(() => {
    if (showThanks && savedFromHereRef.current) {
      savedFromHereRef.current = false;
      thanksTitleRef.current?.focus();
    }
  }, [showThanks]);

  if (handled) {
    return <HandledStopCard {...props} thanksTitleRef={thanksTitleRef} />;
  }
  return (
    <ToCollectStopCard
      {...props}
      onCollect={(bottlesCollected) => {
        savedFromHereRef.current = true;
        onCollect(bottlesCollected);
      }}
      openPart={openPart}
      setOpenPart={setOpenPart}
    />
  );
}

/** Props of {@link ToCollectStopCard}: the card's, plus what is open in it. */
interface ToCollectStopCardProps extends StopCardProps {
  openPart: OpenPart;
  setOpenPart: (part: OpenPart) => void;
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
}: ToCollectStopCardProps) {
  const { order } = stop;
  const name = order.contact.name;
  const lines = stopAddressLines(order.address);
  const [quantity, setQuantity] = useState('');
  const [quantityError, setQuantityError] = useState<string | undefined>(undefined);
  const collectButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
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
      (closing === 'more' ? moreButtonRef : collectButtonRef).current?.focus();
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

  const moreSheet = moreOpen && (
    <MoreActionsSheet
      name={name}
      canMoveUp={canMoveUp}
      canMoveDown={canMoveDown}
      busy={busy}
      onMove={onMove}
      onNotFound={onNotFound}
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

        {error !== undefined && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </li>
    );
  }

  return (
    <li className="stop-card">
      <p className="stop-card-position">עצירה {position}</p>
      <h3 className="stop-card-name">{name}</h3>
      <p className="stop-card-street">{lines.street}</p>
      <p>{lines.spot}</p>
      {lines.note !== undefined && <p className="stop-card-note">הערה: {lines.note}</p>}
      <p className="stop-card-bottles">{bottlesText(order.bottlesEstimated)}</p>
      {!stop.hasLocation && (
        <p className="tag-list">
          <span className="tag">{NO_LOCATION_TAG}</span>
        </p>
      )}

      <div className="stop-card-actions">
        {/* Waze opens in its app or a new tab, and the route stays here for the next stop.
            noopener: Waze's page gets no handle on this one; noreferrer: nor the app's path. */}
        <a
          className="button button-secondary"
          href={wazeUrl(order.address)}
          target="_blank"
          rel="noopener noreferrer"
        >
          נווט{nameSuffix}
        </a>
        <a className="button button-secondary" href={telUrl(order.contact.phone)}>
          {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
          חייג <bdi dir="ltr">{formatIsraeliMobileLocal(order.contact.phone)}</bdi>
          {nameSuffix}
        </a>
      </div>

      {quantityPanel}

      {!quantityOpen && (
        <div className="stop-card-actions">
          <button
            ref={collectButtonRef}
            type="button"
            className="button button-primary"
            aria-disabled={ariaBusy}
            onClick={() => {
              if (!busy) open('quantity');
            }}
          >
            אספתי{nameSuffix}
          </button>
          {moreButton}
        </div>
      )}

      {moreSheet}

      {error !== undefined && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** Props of {@link HandledStopCard}: the card's, plus the thank-you title to focus. */
interface HandledStopCardProps extends StopCardProps {
  thanksTitleRef: RefObject<HTMLHeadingElement | null>;
}

/**
 * A stop with nothing left to do: its state as a badge in words (the colour is never the only
 * signal), the name and the street, and no action or arrow. A collected stop with a thank-you to
 * send shows its "שלח תודה" row; SendList keeps what Yoel tapped while the row stays mounted.
 */
function HandledStopCard({ stop, error, markOpened, thanksTitleRef }: HandledStopCardProps) {
  const { order } = stop;
  // isStopHandled already excluded 'toCollect'; the check narrows the type for the label lookup.
  const label = stop.state === 'toCollect' ? undefined : STOP_STATE_LABELS[stop.state];

  return (
    <li className="stop-card stop-card-handled">
      <h3 className="stop-card-name">{order.contact.name}</h3>
      <p className="stop-card-state">{label}</p>
      <p className="stop-card-street">{stopAddressLines(order.address).street}</p>
      {stop.state === 'collected' && stop.thankYou !== undefined && (
        <div className="stop-card-thanks">
          {/* tabIndex -1: focused from code after "אספתי" saved, never a Tab stop. */}
          <h4 ref={thanksTitleRef} tabIndex={-1} className="stop-card-thanks-title">
            {SEND_THANKS_TITLE}
          </h4>
          <SendList rows={[stop.thankYou]} markOpened={markOpened} />
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
