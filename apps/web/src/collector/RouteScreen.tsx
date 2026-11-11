// The route of one routed round (spec §3.6 step 2, "מסלול"): its stops as StopCards, still to
// collect in driving order and handled ones at the end, and every request a card asks for: the
// arrows (moveStop), "אספתי" (collectStop) and "לא נמצא" (markStopNotFound). At the top, a progress
// card ("עצירה N מתוך M" and one segment per stop); the first stop to collect is the big "העצירה
// הבאה" card whose "נווט" is the ADR-0007 Waze link (the drop-off card once none is left); after
// it come the upcoming stops as a timeline ("הבאות") and the handled ones ("טופלו"); a donation line
// ("בסבב הזה נאספו N בקבוקים, כ־X לתפילין") once something was collected; then the secondary link "כל המסלול ב-Google Maps". Part of the "סבבים"
// tab, not a page of its own: RoundsScreen owns the rounds, renders this under the round's <h2>
// once its phase is `routed`, swaps in every view a saved action answers, and reloads when this
// part says the screen is out of date.
import { EmptyState } from '../components/EmptyState.tsx';
import { useEffect, useId, useRef, useState } from 'react';
import {
  COLLECT_STOP_ERRORS,
  formatShekels,
  type RoundView,
  type RouteStopView,
} from '@bottlerun/shared';
import {
  collectStop as apiCollectStop,
  markStopNotFound as apiMarkStopNotFound,
  moveStop as apiMoveStop,
  type StopActionOutcome,
} from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.tsx';
import {
  dropOffWazeUrl,
  googleMapsRouteUrl,
  isStopHandled,
  keepThankYouRows,
  nextStopToCollect,
  roundDonation,
  screenOrderOfStops,
  storedMovesFor,
} from './routeStops.ts';
import type { SendListProps } from './SendList.tsx';
import { StopCard, type JustSaved } from './StopCard.tsx';

/** In place of the list when the route has no stop at all. */
export const NO_STOPS_TEXT = 'אין עצירות במסלול.';

/** Under the summary: why a card Yoel just handled jumped to the end of the list. */
export const ROUTE_HINT = 'עצירה שטופלה יורדת לסוף הרשימה.';

/** In the card whose action got no usable answer; the same tap can be tried again. */
export const STOP_ACTION_FAILED_MESSAGE = 'לא הצלחנו לשמור. נא לנסות שוב.';

/** A stop action answered 404: the round is gone, or the order is no longer a stop of its route. */
export const STOP_LEFT_ROUTE_MESSAGE = 'העצירה כבר לא במסלול. נא לרענן את המסך.';

/** The drop-off card's button text once no stop is left to collect (ADR-0007). */
export const NAVIGATE_TO_DROP_OFF_TEXT = 'נווט לנקודת הפריקה';

/** The accessible name of the progress card at the top of the route. */
const ROUTE_PROGRESS_LABEL = 'התקדמות המסלול';

/** The progress card's title once no stop is left to collect. */
export const ALL_STOPS_HANDLED_TEXT = 'כל העצירות טופלו';

/** The secondary link to the whole route in Google Maps (ADR-0007). */
export const GOOGLE_MAPS_ROUTE_TEXT = 'כל המסלול ב-Google Maps';

/** Under that link: Google Maps cannot know a stop was handled, so it shows only what is left. */
export const GOOGLE_MAPS_ROUTE_HINT = 'מציג רק עצירות שעוד לא נאספו.';

/** The title of the timeline of the stops still to collect after the current one. */
export const UPCOMING_TITLE = 'הבאות';

/** The title of the list of handled stops. */
export const HANDLED_TITLE = 'טופלו';

/** The accessible name of the current stop's list, which holds the one big card. */
const CURRENT_LIST_LABEL = 'העצירה הנוכחית';

/**
 * The donation line at the bottom (spec §1: the money funds tefillin): what the collected stops
 * brought so far, e.g. "בסבב הזה נאספו 120 בקבוקים, כ־24 ₪ לתפילין". `undefined` while nothing was
 * collected, so the line never says "0".
 */
export function donationLine(stops: readonly RouteStopView[]): string | undefined {
  const { bottles, valueAgorot } = roundDonation(stops);
  if (bottles === 0) return undefined;
  const count = bottles === 1 ? 'בקבוק אחד' : `${bottles} בקבוקים`;
  return `בסבב הזה ${bottles === 1 ? 'נאסף' : 'נאספו'} ${count}, כ־${formatShekels(valueAgorot)} לתפילין`;
}

/**
 * The route at a glance, in words: how many stops were collected out of all of them, and how many
 * are still to collect, e.g. "נאספו 2 מתוך 5 · נשארו 3". A stop not found, cancelled or that left
 * the round counts in the total only. {@link NO_STOPS_TEXT} for a route without stops.
 */
export function routeSummary(stops: readonly Pick<RouteStopView, 'state'>[]): string {
  if (stops.length === 0) return NO_STOPS_TEXT;
  const collected = stops.filter((stop) => stop.state === 'collected').length;
  const toCollect = stops.filter((stop) => stop.state === 'toCollect').length;
  return `נאספו ${collected} מתוך ${stops.length} · נשארו ${toCollect}`;
}

/** `ids` with `id` in it (`present`) or out of it; the same set when nothing changes. */
function withId(ids: ReadonlySet<string>, id: string, present: boolean): ReadonlySet<string> {
  if (ids.has(id) === present) return ids;
  const next = new Set(ids);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/** `messages` with `message` for `id`, or without `id` when undefined; the same map if unchanged. */
function withMessage<Value>(
  messages: ReadonlyMap<string, Value>,
  id: string,
  message: Value | undefined,
): ReadonlyMap<string, Value> {
  if (messages.get(id) === message) return messages;
  const next = new Map(messages);
  if (message === undefined) next.delete(id);
  else next.set(id, message);
  return next;
}

/** Props of {@link RouteScreen}. */
export interface RouteScreenProps {
  /** The routed round as the api last answered it. */
  view: RoundView;
  /** A stop action answered with the round as it is now: the parent swaps it in. */
  onView: (view: RoundView) => void;
  /**
   * The screen is out of date (409 route_not_open / stop_handled / invalid_transition, or 404):
   * the parent shows `message` under the heading and reloads the rounds.
   */
  onStale: (message: string) => void;
  /** True while some quantity field is open: the parent must not reload-on-return then. */
  onTypingChange?: (typing: boolean) => void;
  /** Moves a stop one place in the stored route. Defaults to the api's; tests pass a fake. */
  moveStop?: (
    roundId: string,
    orderId: string,
    direction: 'up' | 'down',
  ) => Promise<StopActionOutcome>;
  /** "אספתי"; undefined `bottlesCollected` means the estimate. Defaults to the api's. */
  collectStop?: (
    roundId: string,
    orderId: string,
    bottlesCollected?: number,
  ) => Promise<StopActionOutcome>;
  /** "לא נמצא". Defaults to the api's. */
  markStopNotFound?: (roundId: string, orderId: string) => Promise<StopActionOutcome>;
  /** Passed to each "שלח תודה" row; undefined keeps SendList's own default (the api). */
  markOpened?: SendListProps['markOpened'];
}

/**
 * The stops of a routed round: a summary in words (a polite live region, so a screen reader hears
 * the new counts after each "אספתי"), then an `<ol>` of {@link StopCard}s, still to collect in
 * driving order and handled at the end (spec §3.6).
 *
 * Every card sends its own requests, one at a time: a second tap on a card whose request is on its
 * way sends nothing, while the other cards keep working. A saved answer goes to `onView`; an answer
 * that says the screen is out of date goes to `onStale`, since the card Yoel tapped may move or
 * vanish once the parent reloads; a refused count shows next to the quantity field; anything else
 * shows in the card, and the button can be tapped again. A 401 leaves for the login.
 */
export function RouteScreen({
  view,
  onView,
  onStale,
  onTypingChange,
  moveStop = apiMoveStop,
  collectStop = apiCollectStop,
  markStopNotFound = apiMarkStopNotFound,
  markOpened,
}: RouteScreenProps) {
  const roundId = view.round.id;

  // The stops shown last, so a newer view never hides a "שלח תודה" row already on screen (see
  // keepThankYouRows: a second tap's answer, or a reload that raced the first "אספתי", can lack it).
  // State, not a ref written during render: when `view.stops` is a new array, the merge is stored
  // right here in render (React's pattern for state that follows a prop) and used at once, so no
  // frame shows the row missing, and a render React throws away cannot leave a half-updated ref.
  const [shown, setShown] = useState(() => ({ source: view.stops, stops: view.stops }));
  let shownStops = shown.stops;
  if (shown.source !== view.stops) {
    shownStops = keepThankYouRows(shown.stops, view.stops);
    setShown({ source: view.stops, stops: shownStops });
  }
  const screenStops = screenOrderOfStops(shownStops);

  // The cards whose request is on its way, and the last error of each card, by order id: an order
  // is one stop of one route at most.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [bottlesErrors, setBottlesErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  // What was just saved for a card (Yoel's own "אספתי" or "כן, לא נמצא", or an arrow), until the
  // card acted on it.
  // Kept here, not in the card: the save moves the card into another list, where React mounts a
  // new one, and that new card is the one that buzzes and takes the focus (StopCard justSaved).
  const [justSaved, setJustSaved] = useState<ReadonlyMap<string, JustSaved>>(() => new Map());
  // The state above reaches a handler only after a re-render; this ref stops a second tap on the
  // same card that comes before it, so one tap sends one request.
  const busyIdsRef = useRef(new Set<string>());
  // False once the part is gone: an answer that comes after Yoel left the tab changes nothing, and
  // above all must not pull him to the login from the screen he went to.
  const mountedRef = useRef(false);

  // The parent's latest callbacks, read after an await and from the cards' typing reports: the
  // parent may hand new arrows on every render, and an answer must reach the current ones.
  const callbacksRef = useRef({ onView, onStale, onTypingChange });
  useEffect(() => {
    callbacksRef.current = { onView, onStale, onTypingChange };
  });

  // The cards whose quantity field is open, and what the parent was last told, so it hears each
  // change of "Yoel is typing somewhere in the route" once, not once per card.
  const typingIdsRef = useRef(new Set<string>());
  const reportedTypingRef = useRef(false);

  function reportTyping(): void {
    const typing = typingIdsRef.current.size > 0;
    if (reportedTypingRef.current === typing) return;
    reportedTypingRef.current = typing;
    callbacksRef.current.onTypingChange?.(typing);
  }

  function typingChanged(orderId: string, typing: boolean): void {
    if (typing) typingIdsRef.current.add(orderId);
    else typingIdsRef.current.delete(orderId);
    reportTyping();
  }

  useEffect(() => {
    mountedRef.current = true;
    const typingIds = typingIdsRef.current;
    return () => {
      mountedRef.current = false;
      // Leaving with a field open must not keep the parent's reload stopped. The cards' own
      // unmount reports come after this one and find nothing left to tell.
      typingIds.clear();
      if (!reportedTypingRef.current) return;
      reportedTypingRef.current = false;
      callbacksRef.current.onTypingChange?.(false);
    };
  }, []);

  /**
   * Starts an action of card `orderId`: false when one is already on its way (nothing is sent).
   * A new action clears the card's last errors.
   */
  function begin(orderId: string): boolean {
    if (busyIdsRef.current.has(orderId)) return false;
    busyIdsRef.current.add(orderId);
    setBusyIds((previous) => withId(previous, orderId, true));
    setErrors((previous) => withMessage(previous, orderId, undefined));
    setBottlesErrors((previous) => withMessage(previous, orderId, undefined));
    return true;
  }

  function end(orderId: string): void {
    busyIdsRef.current.delete(orderId);
    if (mountedRef.current) setBusyIds((previous) => withId(previous, orderId, false));
  }

  /** The request's outcome; the api functions never reject, but a rejection is a failed one. */
  async function send(request: () => Promise<StopActionOutcome>): Promise<StopActionOutcome> {
    try {
      return await request();
    } catch {
      return { kind: 'failed' };
    }
  }

  /** Shows what an answer for card `orderId` means; true when it was saved. */
  function settle(orderId: string, outcome: StopActionOutcome): boolean {
    switch (outcome.kind) {
      case 'saved':
        callbacksRef.current.onView(outcome.view);
        return true;
      case 'stale':
        // Handled elsewhere, the route not open, or the order changed meanwhile: the parent says
        // why and reloads, since this card may move or vanish.
        callbacksRef.current.onStale(outcome.message);
        return false;
      case 'notFound':
        callbacksRef.current.onStale(STOP_LEFT_ROUTE_MESSAGE);
        return false;
      case 'atEdge':
        // Nothing moved: only this card's arrow was out of date.
        setErrors((previous) => withMessage(previous, orderId, outcome.message));
        return false;
      case 'invalid':
        setBottlesErrors((previous) =>
          withMessage(
            previous,
            orderId,
            outcome.fieldErrors.bottlesCollected ?? COLLECT_STOP_ERRORS.bottlesInvalid,
          ),
        );
        return false;
      case 'loggedOut':
        // Replace, not push: "back" from the login must not land on a screen that needs it.
        navigate('/login', { replace: true });
        return false;
      case 'failed':
        // Nothing to reload: the request may not have arrived. The card is free again.
        setErrors((previous) => withMessage(previous, orderId, STOP_ACTION_FAILED_MESSAGE));
        return false;
    }
  }

  /** Card `orderId` should react to `what` once it is drawn from the saved view. */
  function markJustSaved(orderId: string, what: JustSaved): void {
    setJustSaved((previous) => withMessage(previous, orderId, what));
  }

  /**
   * One action of card `orderId`: a single request, its answer shown; `onSaved` runs only when
   * the answer was saved (not for a stale, failed or refused one).
   */
  async function runOnce(
    orderId: string,
    request: () => Promise<StopActionOutcome>,
    onSaved?: () => void,
  ): Promise<void> {
    if (!begin(orderId)) return;
    const outcome = await send(request);
    end(orderId);
    if (mountedRef.current && settle(orderId, outcome)) onSaved?.();
  }

  /**
   * An arrow tap: the stop passes its nearest to-collect neighbour on screen. The stored route
   * still holds the handled stops between them, so that takes `storedMovesFor` single moves, sent
   * one after the other (each needs the previous one stored); every saved answer is swapped in, so
   * the parent always shows the newest route. The first answer that is not saved ends it.
   */
  async function move(orderId: string, direction: 'up' | 'down'): Promise<void> {
    // Counted on the view of the tap: the one whose arrows Yoel saw.
    const moves = storedMovesFor(view.stops, orderId, direction);
    if (moves === 0 || !begin(orderId)) return;
    let movedAtAll = false;
    for (let done = 0; done < moves; done += 1) {
      const outcome = await send(() => moveStop(roundId, orderId, direction));
      if (!mountedRef.current) break;
      if (!settle(orderId, outcome)) break;
      movedAtAll = true;
    }
    end(orderId);
    if (movedAtAll && mountedRef.current) markJustSaved(orderId, 'moved');
  }

  // Both links read the STORED order (shownStops), not the screen order, so "next" is the next one
  // planRoute chose; after "אספתי" the new view re-renders them with no extra code.
  const nextStop = nextStopToCollect(shownStops);
  const mapsUrl = googleMapsRouteUrl(shownStops);

  // "עצירה N מתוך M": N counts the stops already handled (collected or not) plus the current one.
  const handledCount = shownStops.filter((stop) => isStopHandled(stop.state)).length;
  const currentOrderId = nextStop?.order.id;

  // The screen order cut in three: the first stop to collect (big card), the other stops to collect
  // (timeline), the handled ones. Concatenated they are screenStops again.
  const toCollectStops = screenStops.filter((stop) => !isStopHandled(stop.state));
  const currentStops = toCollectStops.slice(0, 1);
  const upcomingStops = toCollectStops.slice(1);
  const handledStops = screenStops.slice(toCollectStops.length);
  const upcomingTitleId = useId();
  const handledTitleId = useId();
  const donation = donationLine(shownStops);

  /** One card of the list, numbered by its place in the whole screen order. */
  function renderCard(stop: RouteStopView) {
    const orderId = stop.order.id;
    return (
      // Keyed by the order: a card keeps its open field and focus when it moves inside its list.
      // A move into another list (current, upcoming, handled) mounts a new card; justSaved tells
      // that new card what Yoel just did there.
      <StopCard
        key={orderId}
        stop={stop}
        position={screenStops.indexOf(stop) + 1}
        current={orderId === currentOrderId}
        canMoveUp={storedMovesFor(view.stops, orderId, 'up') > 0}
        canMoveDown={storedMovesFor(view.stops, orderId, 'down') > 0}
        busy={busyIds.has(orderId)}
        error={errors.get(orderId)}
        bottlesError={bottlesErrors.get(orderId)}
        onMove={(direction) => void move(orderId, direction)}
        onCollect={(bottlesCollected) =>
          void runOnce(
            orderId,
            () => collectStop(roundId, orderId, bottlesCollected),
            () => markJustSaved(orderId, 'collected'),
          )
        }
        onNotFound={() =>
          void runOnce(
            orderId,
            () => markStopNotFound(roundId, orderId),
            () => markJustSaved(orderId, 'notFound'),
          )
        }
        onTypingChange={(typing) => typingChanged(orderId, typing)}
        markOpened={markOpened}
        justSaved={justSaved.get(orderId)}
        onJustSavedSeen={() =>
          setJustSaved((previous) => withMessage(previous, orderId, undefined))
        }
      />
    );
  }

  return (
    <>
      {shownStops.length === 0 ? (
        screenStops.length === 0 ? (
          <EmptyState icon="route" text={NO_STOPS_TEXT} />
        ) : (
          <p className="round-summary" aria-live="polite">
            {routeSummary(screenStops)}
          </p>
        )
      ) : (
        <div className="card route-progress" role="group" aria-label={ROUTE_PROGRESS_LABEL}>
          <p className="route-progress-title">
            {nextStop === undefined
              ? ALL_STOPS_HANDLED_TEXT
              : `עצירה ${handledCount + 1} מתוך ${shownStops.length}`}
          </p>
          {/* One segment per stop: done, then the current one, then those still ahead. Decoration;
              the words above and the summary below carry the meaning. */}
          <div className="route-progress-bar" aria-hidden="true">
            {shownStops.map((stop, index) => (
              <i
                key={stop.order.id}
                className={
                  index < handledCount
                    ? 'route-progress-done'
                    : index === handledCount && nextStop !== undefined
                      ? 'route-progress-current'
                      : undefined
                }
              />
            ))}
          </div>
          {/* The accessible text of the same progress; a polite live region, so a screen reader
              hears the new counts after each "אספתי". */}
          <p className="round-summary" aria-live="polite">
            {routeSummary(screenStops)}
          </p>
        </div>
      )}
      {nextStop === undefined && shownStops.length > 0 && (
        // No stop left: the card Yoel taps to drive to the drop-off (ADR-0007). Plain anchor, like
        // the per-stop "נווט": the app opens Waze in its app or a new tab, and the route stays here.
        <div className="card route-drop-off">
          <a
            className="button button-primary button-big button-block"
            href={dropOffWazeUrl()}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="navigate" />
            {NAVIGATE_TO_DROP_OFF_TEXT}
          </a>
        </div>
      )}
      {screenStops.length > 0 && (
        <>
          <p className="round-hint">{ROUTE_HINT}</p>
          {/* One flow in screenOrderOfStops order, in three lists: the current stop, the upcoming
              timeline, the handled ones. Splitting changes only the markup, never the order. */}
          {currentStops.length > 0 && (
            <ol className="order-list" aria-label={CURRENT_LIST_LABEL}>
              {currentStops.map(renderCard)}
            </ol>
          )}
          {upcomingStops.length > 0 && (
            <>
              <p className="route-section-title" id={upcomingTitleId}>
                {UPCOMING_TITLE}
              </p>
              <ol className="timeline" aria-labelledby={upcomingTitleId}>
                {upcomingStops.map(renderCard)}
              </ol>
            </>
          )}
          {handledStops.length > 0 && (
            <>
              <p className="route-section-title" id={handledTitleId}>
                {HANDLED_TITLE}
              </p>
              <ol className="order-list" aria-labelledby={handledTitleId}>
                {handledStops.map(renderCard)}
              </ol>
            </>
          )}
        </>
      )}
      {donation !== undefined && <p className="card route-donation">{donation}</p>}
      {/* Last: a secondary link, so the current stop stays near the top of the phone screen. */}
      {mapsUrl !== undefined && (
        <div className="route-navigation">
          <a
            className="button button-secondary button-block"
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {GOOGLE_MAPS_ROUTE_TEXT}
          </a>
          <p className="round-hint">{GOOGLE_MAPS_ROUTE_HINT}</p>
        </div>
      )}
    </>
  );
}
