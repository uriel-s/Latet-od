// The route of one routed round (spec §3.6 step 2, "מסלול"): its stops as StopCards, still to
// collect in driving order and handled ones at the end, and every request a card asks for: the
// arrows (moveStop), "אספתי" (collectStop) and "לא נמצא" (markStopNotFound). Part of the "סבבים"
// tab, not a page of its own: RoundsScreen owns the rounds, renders this under the round's <h2>
// once its phase is `routed`, swaps in every view a saved action answers, and reloads when this
// part says the screen is out of date.
import { useEffect, useRef, useState } from 'react';
import { COLLECT_STOP_ERRORS, type RoundView, type RouteStopView } from '@bottlerun/shared';
import {
  collectStop as apiCollectStop,
  markStopNotFound as apiMarkStopNotFound,
  moveStop as apiMoveStop,
  type StopActionOutcome,
} from '../api.ts';
import { navigate } from '../router.tsx';
import { keepThankYouRows, screenOrderOfStops, storedMovesFor } from './routeStops.ts';
import type { SendListProps } from './SendList.tsx';
import { StopCard } from './StopCard.tsx';

/** In place of the list when the route has no stop at all. */
export const NO_STOPS_TEXT = 'אין עצירות במסלול.';

/** Under the summary: why a card Yoel just handled jumped to the end of the list. */
export const ROUTE_HINT = 'עצירה שטופלה יורדת לסוף הרשימה.';

/** In the card whose action got no usable answer; the same tap can be tried again. */
export const STOP_ACTION_FAILED_MESSAGE = 'לא הצלחנו לשמור. נא לנסות שוב.';

/** A stop action answered 404: the round is gone, or the order is no longer a stop of its route. */
export const STOP_LEFT_ROUTE_MESSAGE = 'העצירה כבר לא במסלול. נא לרענן את המסך.';

/** The accessible name of the list of stops. */
const ROUTE_LIST_LABEL = 'עצירות המסלול';

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
function withMessage(
  messages: ReadonlyMap<string, string>,
  id: string,
  message: string | undefined,
): ReadonlyMap<string, string> {
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

  /** One action of card `orderId`: a single request, its answer shown. */
  async function runOnce(
    orderId: string,
    request: () => Promise<StopActionOutcome>,
  ): Promise<void> {
    if (!begin(orderId)) return;
    const outcome = await send(request);
    end(orderId);
    if (mountedRef.current) settle(orderId, outcome);
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
    for (let done = 0; done < moves; done += 1) {
      const outcome = await send(() => moveStop(roundId, orderId, direction));
      if (!mountedRef.current) break;
      if (!settle(orderId, outcome)) break;
    }
    end(orderId);
  }

  return (
    <>
      <p className="round-summary" aria-live="polite">
        {routeSummary(screenStops)}
      </p>
      {screenStops.length > 0 && (
        <>
          <p className="round-hint">{ROUTE_HINT}</p>
          <ol className="order-list" aria-label={ROUTE_LIST_LABEL}>
            {screenStops.map((stop, index) => {
              const orderId = stop.order.id;
              return (
                // Keyed by the order, so a card keeps its open field and focus when it moves.
                <StopCard
                  key={orderId}
                  stop={stop}
                  position={index + 1}
                  canMoveUp={storedMovesFor(view.stops, orderId, 'up') > 0}
                  canMoveDown={storedMovesFor(view.stops, orderId, 'down') > 0}
                  busy={busyIds.has(orderId)}
                  error={errors.get(orderId)}
                  bottlesError={bottlesErrors.get(orderId)}
                  onMove={(direction) => void move(orderId, direction)}
                  onCollect={(bottlesCollected) =>
                    void runOnce(orderId, () => collectStop(roundId, orderId, bottlesCollected))
                  }
                  onNotFound={() => void runOnce(orderId, () => markStopNotFound(roundId, orderId))}
                  onTypingChange={(typing) => typingChanged(orderId, typing)}
                  markOpened={markOpened}
                />
              );
            })}
          </ol>
        </>
      )}
    </>
  );
}
