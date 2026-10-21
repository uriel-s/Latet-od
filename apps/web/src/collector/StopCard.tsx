// One stop of the route screen (spec §3.6 step 2, "מסלול"): who, where, how many bottles, and
// what Yoel does there: "נווט" (Waze), "חייג", "אספתי" with the real quantity, "לא נמצא", and the
// arrows that move the stop in the route. A handled stop shows its state in words and, once
// collected, its "שלח תודה" row (SendList.tsx). Presentational: the route screen sends every
// request and tells this card whether one is on its way and why it failed; the card owns only
// what is open in it (the quantity field, the "לא נמצא" question) and where focus goes.
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  COLLECT_STOP_ERRORS,
  collectStopRequestSchema,
  formatIsraeliMobileLocal,
  type RouteStopView,
} from '@bottlerun/shared';
import { TextField } from '../components/TextField.tsx';
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

/** The in-card question "לא נמצא" opens: a mistap would otherwise block "אספתי" (stop_handled). */
export const NOT_FOUND_QUESTION = 'לסמן שהלקוח לא נמצא?';

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

/** What is open in a card still to collect: nothing, the quantity field, or the question. */
type OpenPart = 'none' | 'quantity' | 'notFoundQuestion';

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
  // The field and the question close by themselves once the stop is handled (the saved view, or
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
  const questionId = useId();
  const collectButtonRef = useRef<HTMLButtonElement>(null);
  const notFoundButtonRef = useRef<HTMLButtonElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);

  /**
   * Opens or closes a part of the card. flushSync renders first, so the element to focus exists,
   * and the focus call stays inside the tap: to the new part when it opens (the button just tapped
   * is gone), and back to that button when it closes.
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
    } else if (part === 'notFoundQuestion') {
      questionRef.current?.focus();
    } else {
      (closing === 'quantity' ? collectButtonRef : notFoundButtonRef).current?.focus();
    }
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

      {openPart === 'quantity' && (
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
          <div className="cancel-confirm-actions">
            <button type="submit" className="button button-primary" aria-disabled={ariaBusy}>
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
      )}

      {openPart === 'notFoundQuestion' && (
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
                if (!busy) open('none');
              }}
            >
              לא
            </button>
          </div>
        </div>
      )}

      {openPart === 'none' && (
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
          <button
            ref={notFoundButtonRef}
            type="button"
            className="button button-secondary"
            aria-disabled={ariaBusy}
            onClick={() => {
              if (!busy) open('notFoundQuestion');
            }}
          >
            לא נמצא{nameSuffix}
          </button>
        </div>
      )}

      {(canMoveUp || canMoveDown) && (
        <div className="stop-card-actions stop-card-moves">
          {canMoveUp && (
            <button
              type="button"
              className="button button-secondary"
              aria-disabled={ariaBusy}
              onClick={() => {
                if (!busy) onMove('up');
              }}
            >
              {/* The arrow first and hidden, so the accessible name starts with the words. */}
              <span aria-hidden="true">▲</span> הזז למעלה{nameSuffix}
            </button>
          )}
          {canMoveDown && (
            <button
              type="button"
              className="button button-secondary"
              aria-disabled={ariaBusy}
              onClick={() => {
                if (!busy) onMove('down');
              }}
            >
              <span aria-hidden="true">▼</span> הזז למטה{nameSuffix}
            </button>
          )}
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
