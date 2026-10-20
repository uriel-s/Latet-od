// The "סבבים" tab of the collector app (spec §3.6), one section per open round.
// Step 1 "אישורים" (phase `confirming`): who confirmed, who did not yet, and who asked for another
// date; the round's "שלח" list of confirmation requests (ADR-0003, SendList.tsx); "אישר בטלפון"
// for a customer who confirmed in a call or in a WhatsApp reply; and "סגור אישורים ובנה מסלול",
// asked as a question first. Step 2 "מסלול" (phase `routed`): the route's stops (RouteScreen.tsx).
// GET /api/collector/rounds sends the rounds already grouped and routed (the shared
// buildRoundView), so this screen only shows them, and after each action it swaps in the round as
// the api answers it.
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  REGION_LABELS,
  ROUND_GROUP_KEYS,
  ROUND_GROUP_LABELS,
  ROUND_MESSAGES,
  formatDayMonth,
  formatIsraeliMobileLocal,
  type CollectorOrder,
  type RoundGroupKey,
  type RoundOrderGroup,
  type RoundView,
} from '@bottlerun/shared';
import {
  buildRoute as apiBuildRoute,
  confirmOrderByPhone,
  fetchRounds,
  type BuildRouteOutcome,
  type ConfirmByPhoneOutcome,
  type RoundsOutcome,
} from '../api.ts';
import { Link, navigate } from '../router.tsx';
import { bottlesText, ordersText } from './OrdersScreen.tsx';
import { orderTags } from './orderTags.ts';
import { RouteScreen, type RouteScreenProps } from './RouteScreen.tsx';
import { SendList, type SendListProps } from './SendList.tsx';
import { useReloadOnReturn } from './useReloadOnReturn.ts';

/** Shown when the rounds got no usable answer (network error, 5xx, unreadable body). */
export const ROUNDS_LOAD_FAILED_MESSAGE =
  'לא הצלחנו לטעון את הסבבים. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** In place of the rounds when none is open, above the link to plan one. */
export const NO_OPEN_ROUND_TEXT = 'אין סבב פתוח.';

/** The summary of a group with no orders, in place of its count and list. */
export const EMPTY_ROUND_GROUP_TEXT = 'אין';

/** Above the "שלח" list: what one tap does, and the second tap that is left to Yoel (ADR-0003). */
export const SEND_LIST_HINT =
  'לחיצה על "שלח" פותחת את WhatsApp עם ההודעה כבר כתובה, ושם לוחצים "שלח".';

/** Next to a card whose "אישר בטלפון" got no usable answer; the button can be tapped again. */
export const CONFIRM_FAILED_MESSAGE = 'לא הצלחנו לשמור. נא לנסות שוב.';

/** "אישר בטלפון" answered 404: the order (or its round) left the round meanwhile. */
export const ORDER_LEFT_ROUND_MESSAGE = 'ההזמנה כבר לא בסבב.';

const CONFIRM_LABEL = 'אישר בטלפון';
const CONFIRMING_LABEL = 'שומר...';

/** The button at the end of a round in step 1 (spec §3.6). */
export const BUILD_ROUTE_LABEL = 'סגור אישורים ובנה מסלול';
const BUILD_ROUTE_YES_LABEL = 'כן, לבנות מסלול';
const BUILD_ROUTE_NO_LABEL = 'לא, עוד לא';
const BUILDING_ROUTE_LABEL = 'בונה מסלול...';

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

/** Where "תכנון סבב" leads when no round is open (PlanRoundScreen.tsx). */
const PLAN_ROUND_PATH = '/app/orders/plan';

/**
 * The orders of the group `key`, as the api listed them (plan order). The api always sends the
 * three groups; a missing one shows as empty rather than breaking the screen.
 */
function ordersOfGroup(groups: readonly RoundOrderGroup[], key: RoundGroupKey): CollectorOrder[] {
  return groups.find((group) => group.key === key)?.orders ?? [];
}

/**
 * The round's confirmations at a glance, in words and in {@link ROUND_GROUP_KEYS} order (spec
 * §3.6: "מי אישר, מי עוד לא, ומי ביקש מועד אחר"), e.g.
 * "אישרו: 2 · עוד לא אישרו: 3 · ביקשו מועד אחר: 1".
 */
export function confirmationSummary(groups: readonly RoundOrderGroup[]): string {
  return ROUND_GROUP_KEYS.map(
    (key) => `${ROUND_GROUP_LABELS[key]}: ${ordersOfGroup(groups, key).length}`,
  ).join(' · ');
}

/** `ids` with `id` in it (`present`) or out of it; the same set when nothing changes. */
function withId(ids: ReadonlySet<string>, id: string, present: boolean): ReadonlySet<string> {
  if (ids.has(id) === present) return ids;
  const next = new Set(ids);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/** Props of {@link RoundsScreen}. Each function must keep its identity across renders. */
export interface RoundsScreenProps {
  /**
   * Loads the open rounds. Defaults to {@link fetchRounds}; tests pass a fake. A module function,
   * not an inline arrow: a new one loads again.
   */
  loadRounds?: () => Promise<RoundsOutcome>;
  /** Yoel's "אישר בטלפון". Defaults to {@link confirmOrderByPhone}; tests pass a fake. */
  confirmByPhone?: (roundId: string, orderId: string) => Promise<ConfirmByPhoneOutcome>;
  /**
   * "סגור אישורים ובנה מסלול". Defaults to the api's {@link apiBuildRoute}; tests pass a fake.
   */
  buildRoute?: (roundId: string) => Promise<BuildRouteOutcome>;
  /** A route's arrows; undefined keeps RouteScreen's own default (the api). */
  moveStop?: RouteScreenProps['moveStop'];
  /** A stop's "אספתי"; undefined keeps RouteScreen's own default (the api). */
  collectStop?: RouteScreenProps['collectStop'];
  /** A stop's "לא נמצא"; undefined keeps RouteScreen's own default (the api). */
  markStopNotFound?: RouteScreenProps['markStopNotFound'];
  /**
   * Passed to the "שלח" list and the route's "שלח תודה" rows; undefined keeps SendList's own
   * default (the api).
   */
  markOpened?: SendListProps['markOpened'];
}

/** What the screen shows. A logged-out answer leaves for /login and needs no state of its own. */
type ScreenState =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; rounds: RoundView[] };

/**
 * A message about the screen as a whole, under the heading. An object, so the same words a second
 * time are a new notice and move the focus to it again.
 */
interface Notice {
  message: string;
}

/**
 * The rounds tab. Renders the page's only `<h1>` (Layout's heading rule) in every state. The open
 * rounds load once per visit to the tab (each visit mounts the screen anew), again on
 * "לנסות שוב", and again when Yoel comes back to the app ({@link useReloadOnReturn}: the installed
 * app has no pull-to-refresh, and "שלח" sends him to WhatsApp and back all the time). That reload
 * keeps what is shown until its answer replaces it. With none open, it says so and links to the
 * planning screen.
 *
 * A 401 means the session ended: to the login, like the guard in CollectorApp.tsx. A failed load
 * stays here with a retry: a dropped connection is not a logout.
 *
 * "אישר בטלפון" swaps in the round the api answers: the customer moves to "אישרו" and leaves the
 * "שלח" list. When the api says the order can no longer be confirmed, or is no longer in the
 * round, the screen says so under the heading, moves the focus there (the card Yoel tapped may be
 * gone after the reload), and loads the rounds again without blanking them first.
 *
 * "סגור אישורים ובנה מסלול" swaps in the routed round the api answers, so the section shows its
 * route in place of the confirmations. A route already built, or a round gone, is the same kind of
 * out-of-date screen as above: a notice and a reload. Each stop action of the route is sent by
 * RouteScreen; this screen swaps in its answer, or shows its notice and reloads.
 *
 * The reload on coming back is skipped while a quantity field of "אספתי" is open: a reload must
 * never wipe what Yoel types (a failed load replaces the rounds, and a stop handled elsewhere
 * closes its field). The usual trip away mid-route is to Waze or the dialler; once the field is
 * closed, the next return reloads as before.
 */
export function RoundsScreen({
  loadRounds = fetchRounds,
  confirmByPhone = confirmOrderByPhone,
  buildRoute = apiBuildRoute,
  moveStop,
  collectStop,
  markStopNotFound,
  markOpened,
}: RoundsScreenProps) {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the loads asked for after the first ("לנסות שוב", a reload after a refused
  // "אישר בטלפון", or Yoel coming back to the app): a new value runs the load below again.
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // The orders whose "אישר בטלפון" is on its way ("שומר..."), and those whose last one failed.
  // By order id: an order is in one open round at most (spec §4), and only its own round's
  // "עוד לא אישרו" group has the button.
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  // The state above reaches the handler only after a re-render; this ref stops a second tap on the
  // same card that comes before it, so one tap sends one request.
  const busyIdsRef = useRef(new Set<string>());
  // The rounds whose route build is on its way ("בונה מסלול..."), and those whose last one failed,
  // by round id; the ref is the same double-tap guard as busyIdsRef.
  const [buildingIds, setBuildingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [buildFailedIds, setBuildFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const buildingIdsRef = useRef(new Set<string>());
  // The routed rounds with a quantity field open (RouteScreen's onTypingChange). A ref, not state:
  // only the reload-on-return callback reads it, and a change must not re-render the screen.
  const typingRoundIdsRef = useRef(new Set<string>());
  // False once the screen is gone: an answer that comes after Yoel left the tab must not pull him
  // to the login from the screen he went to.
  const mountedRef = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // False once this load's answer no longer matters: Yoel left the tab, a newer load started,
    // or React's StrictMode ran the effect a second time (dev only). A stale answer changes
    // nothing; above all, a late "logged out" must not pull him to the login from another screen.
    let current = true;

    function settle(outcome: RoundsOutcome): void {
      if (!current) return;
      switch (outcome.kind) {
        case 'loaded':
          setState({ kind: 'loaded', rounds: outcome.rounds });
          return;
        case 'loggedOut':
          // Replace, not push: "back" from the login must not land on a screen that needs it.
          navigate('/login', { replace: true });
          return;
        case 'failed':
          setState({ kind: 'failed' });
          return;
      }
    }

    // fetchRounds never rejects; a rejection is a failed load like any other.
    loadRounds().then(settle, () => settle({ kind: 'failed' }));
    return () => {
      current = false;
    };
  }, [loadRounds, attempt]);

  // A new notice gets the focus, which also scrolls it into view: Yoel tapped a card further
  // down, and that card may move or vanish when the rounds load again.
  useEffect(() => {
    if (notice !== undefined) noticeRef.current?.focus();
  }, [notice]);

  function retry(): void {
    setState({ kind: 'loading' });
    setNotice(undefined);
    setAttempt((previous) => previous + 1);
  }

  /** Loads the rounds again, keeping the ones shown until the answer replaces them. */
  function reload(): void {
    setAttempt((previous) => previous + 1);
  }

  // Back in the app: the same reload, rounds kept on screen. A notice stays: the usual trip away is
  // to WhatsApp from "שלח", and the notice still explains why the card Yoel tapped moved or left;
  // his next "אישר בטלפון" or "לנסות שוב" clears it, as before. Skipped while he is typing a
  // quantity (see the doc comment above): nothing is lost, the next return loads.
  useReloadOnReturn(() => {
    if (typingRoundIdsRef.current.size === 0) reload();
  });

  /** RouteScreen of round `roundId` reports whether one of its quantity fields is open. */
  function typingChanged(roundId: string, typing: boolean): void {
    if (typing) typingRoundIdsRef.current.add(roundId);
    else typingRoundIdsRef.current.delete(roundId);
  }

  /** The screen is out of date: says why under the heading and loads the rounds again. */
  function showStale(message: string): void {
    setNotice({ message });
    reload();
  }

  /** Shows `view` in place of the round with its id; the other rounds stay as they are. */
  function replaceRound(view: RoundView): void {
    setState((previous) =>
      previous.kind === 'loaded'
        ? {
            kind: 'loaded',
            rounds: previous.rounds.map((shown) =>
              shown.round.id === view.round.id ? view : shown,
            ),
          }
        : previous,
    );
  }

  /** Yoel's "אישר בטלפון" on `orderId` of round `roundId` (spec §3.6). */
  async function confirm(roundId: string, orderId: string): Promise<void> {
    if (busyIdsRef.current.has(orderId)) return;
    busyIdsRef.current.add(orderId);
    setSavingIds((previous) => withId(previous, orderId, true));
    setFailedIds((previous) => withId(previous, orderId, false));
    setNotice(undefined);

    let outcome: ConfirmByPhoneOutcome;
    try {
      outcome = await confirmByPhone(roundId, orderId);
    } catch {
      // confirmOrderByPhone never rejects, but a rejection must not leave the card on "שומר...".
      outcome = { kind: 'failed' };
    }
    busyIdsRef.current.delete(orderId);
    if (!mountedRef.current) return;
    setSavingIds((previous) => withId(previous, orderId, false));

    switch (outcome.kind) {
      case 'confirmed':
        // The api's round as it is now: the customer is in "אישרו" and has no "שלח" row.
        replaceRound(outcome.view);
        return;
      case 'closed':
        // The round's confirmations were closed, or the order was cancelled or collected
        // meanwhile (on another phone or tab): the screen is out of date.
        setNotice({ message: outcome.message });
        reload();
        return;
      case 'notFound':
        setNotice({ message: ORDER_LEFT_ROUND_MESSAGE });
        reload();
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      case 'failed':
        // Nothing to reload: the request may not have arrived. The button is free again.
        setFailedIds((previous) => withId(previous, orderId, true));
        return;
    }
  }

  /** Yoel's "כן, לבנות מסלול" for round `roundId` (spec §3.6, "סגור אישורים ובנה מסלול"). */
  async function buildRouteOf(roundId: string): Promise<void> {
    if (buildingIdsRef.current.has(roundId)) return;
    buildingIdsRef.current.add(roundId);
    setBuildingIds((previous) => withId(previous, roundId, true));
    setBuildFailedIds((previous) => withId(previous, roundId, false));
    setNotice(undefined);

    let outcome: BuildRouteOutcome;
    try {
      outcome = await buildRoute(roundId);
    } catch {
      // buildRoute never rejects, but a rejection must not leave the question on "בונה מסלול...".
      outcome = { kind: 'failed' };
    }
    buildingIdsRef.current.delete(roundId);
    if (!mountedRef.current) return;
    setBuildingIds((previous) => withId(previous, roundId, false));

    switch (outcome.kind) {
      case 'built':
        // Phase `routed`: the section shows the route in place of the confirmations.
        replaceRound(outcome.view);
        return;
      case 'closed':
        // Built already (a second tap's answer, another phone or tab) or closed: out of date.
        showStale(outcome.message);
        return;
      case 'notFound':
        showStale(ROUND_MESSAGES.roundNotFound);
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      case 'failed':
        // Nothing to reload: the request may not have arrived. The question stays open for "כן".
        setBuildFailedIds((previous) => withId(previous, roundId, true));
        return;
    }
  }

  return (
    <>
      <h1>סבבים</h1>

      {notice !== undefined && (
        // tabIndex -1: focusable from code only (the effect above), never a Tab stop.
        <p ref={noticeRef} className="form-alert" role="alert" tabIndex={-1}>
          {notice.message}
        </p>
      )}

      {state.kind === 'loading' && <p role="status">טוען...</p>}

      {state.kind === 'failed' && (
        <>
          <p className="form-alert" role="alert">
            {ROUNDS_LOAD_FAILED_MESSAGE}
          </p>
          <button type="button" className="button button-primary button-block" onClick={retry}>
            לנסות שוב
          </button>
        </>
      )}

      {state.kind === 'loaded' && state.rounds.length === 0 && (
        <>
          <p>{NO_OPEN_ROUND_TEXT}</p>
          <Link to={PLAN_ROUND_PATH} className="button button-primary button-block">
            תכנון סבב
          </Link>
        </>
      )}

      {state.kind === 'loaded' &&
        state.rounds.map((view) => (
          // Keyed by the round's id, so the section, and the "שלח" list or the route in it, stay
          // mounted when an action swaps in a new view: the rows Yoel already opened stay marked,
          // and an open quantity field stays open.
          <RoundSection
            key={view.round.id}
            view={view}
            markOpened={markOpened}
            savingIds={savingIds}
            failedIds={failedIds}
            onConfirm={(orderId) => void confirm(view.round.id, orderId)}
            buildRoute={{
              building: buildingIds.has(view.round.id),
              failed: buildFailedIds.has(view.round.id),
              onBuild: () => void buildRouteOf(view.round.id),
              onOpenChange: () =>
                setBuildFailedIds((previous) => withId(previous, view.round.id, false)),
            }}
            route={{
              // A saved stop action: its answer replaces the round, and an old notice has served.
              onView: (next) => {
                setNotice(undefined);
                replaceRound(next);
              },
              onStale: showStale,
              onTypingChange: (typing) => typingChanged(view.round.id, typing),
              moveStop,
              collectStop,
              markStopNotFound,
              markOpened,
            }}
          />
        ))}
    </>
  );
}

/** What a step-1 section needs for "סגור אישורים ובנה מסלול"; the screen sends the request. */
interface SectionBuildRoute {
  /** True while the build is on its way ("בונה מסלול..."). */
  building: boolean;
  /** True when the last build got no usable answer. */
  failed: boolean;
  /** "כן, לבנות מסלול". Called on every tap, a busy one too: the screen keeps its own guard. */
  onBuild: () => void;
  /** The question opened or closed; the screen clears an old error here. */
  onOpenChange: () => void;
}

/** What a step-2 section passes to its {@link RouteScreen}: everything but the view. */
type SectionRoute = Omit<RouteScreenProps, 'view'>;

/** Props of {@link RoundSection}. */
interface RoundSectionProps {
  view: RoundView;
  markOpened: SendListProps['markOpened'];
  /** Orders whose "אישר בטלפון" is on its way. */
  savingIds: ReadonlySet<string>;
  /** Orders whose last "אישר בטלפון" failed. */
  failedIds: ReadonlySet<string>;
  onConfirm: (orderId: string) => void;
  /** Step 1's last button. */
  buildRoute: SectionBuildRoute;
  /** Step 2's route. */
  route: SectionRoute;
}

/**
 * One open round as a named region (its `<h2>`, the half of the city and the day, labels it), top
 * to bottom: the pickup time and the personal text that went into the requests, then the round's
 * step (spec §3.6).
 *
 * Step 1 (phase `confirming`): the confirmation counts, the "שלח" list, the three groups of orders
 * (every group shows, an empty one too, so the layout does not jump as customers confirm), and
 * last "סגור אישורים ובנה מסלול": the step that ends step 1 comes after everything Yoel checks
 * before it, and lies apart from the "אישר בטלפון" buttons.
 *
 * Step 2 (phase `routed`): the route alone. Its own summary takes the place of the confirmation
 * counts (one live summary per round, not two), and the groups and the "שלח" list are gone:
 * whoever did not confirm left the round when it was built.
 *
 * When a build swaps step 1 for step 2, the question Yoel answered is gone, so the focus goes to
 * the round's heading, at the top of its route. Only when the focus was lost that way (on the page
 * itself, or still in this section): a notice the screen focused meanwhile keeps it.
 */
function RoundSection({
  view,
  markOpened,
  savingIds,
  failedIds,
  onConfirm,
  buildRoute,
  route,
}: RoundSectionProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { round, groups, sendList } = view;
  const routed = round.phase === 'routed';
  const wasRoutedRef = useRef(routed);

  useEffect(() => {
    const becameRouted = routed && !wasRoutedRef.current;
    wasRoutedRef.current = routed;
    if (!becameRouted) return;
    const active = document.activeElement;
    const focusLost =
      active === null || active === document.body || sectionRef.current?.contains(active) === true;
    if (focusLost) headingRef.current?.focus();
  }, [routed]);

  return (
    <section ref={sectionRef} className="round" aria-labelledby={headingId}>
      {/* tabIndex -1: focused from code after the route is built, never a Tab stop. */}
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        {REGION_LABELS[round.region]} ·{' '}
        {/* DD/MM reads left to right inside the right-to-left text (CLAUDE.md). */}
        <bdi dir="ltr">{formatDayMonth(round.date)}</bdi>
      </h2>
      {round.pickupBy !== undefined && (
        <p>
          להוציא את הבקבוקים עד <bdi dir="ltr">{round.pickupBy}</bdi>
        </p>
      )}
      {round.personalText !== undefined && (
        <p className="round-personal-text">טקסט אישי: {round.personalText}</p>
      )}

      {routed ? (
        // Not keyed by anything that changes: it stays mounted across every swapped view, so an
        // open quantity field and the "שלח תודה" rows Yoel tapped stay as they are.
        <RouteScreen view={view} {...route} />
      ) : (
        <>
          {/* Polite live text: a screen reader hears the new counts after "אישר בטלפון". */}
          <p className="round-summary" aria-live="polite">
            {confirmationSummary(groups)}
          </p>

          <h3>בקשות אישור</h3>
          {sendList.length > 0 && <p className="round-hint">{SEND_LIST_HINT}</p>}
          {/* Always rendered at this place, so it stays mounted across a swapped view; it shows its
              own text when no request is left to send. */}
          <SendList rows={sendList} markOpened={markOpened} />

          {ROUND_GROUP_KEYS.map((key) => (
            <RoundGroupSection
              key={key}
              groupKey={key}
              orders={ordersOfGroup(groups, key)}
              savingIds={savingIds}
              failedIds={failedIds}
              onConfirm={onConfirm}
            />
          ))}

          <BuildRouteConfirm
            question={buildRouteQuestion(ordersOfGroup(groups, 'pending').length)}
            {...buildRoute}
          />
        </>
      )}
    </section>
  );
}

/** Props of {@link BuildRouteConfirm}. */
interface BuildRouteConfirmProps extends SectionBuildRoute {
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
function BuildRouteConfirm({
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

/** Props of {@link RoundGroupSection}. */
interface RoundGroupSectionProps {
  groupKey: RoundGroupKey;
  orders: readonly CollectorOrder[];
  savingIds: ReadonlySet<string>;
  failedIds: ReadonlySet<string>;
  onConfirm: (orderId: string) => void;
}

/**
 * One group of the round ("אישרו", "עוד לא אישרו", "ביקשו מועד אחר") as a named region, with its
 * order count, or {@link EMPTY_ROUND_GROUP_TEXT} and no list. Only "עוד לא אישרו" has the
 * "אישר בטלפון" button on its cards.
 */
function RoundGroupSection({
  groupKey,
  orders,
  savingIds,
  failedIds,
  onConfirm,
}: RoundGroupSectionProps) {
  const headingId = useId();

  return (
    <section className="round-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{ROUND_GROUP_LABELS[groupKey]}</h3>
      <p className="order-group-summary">
        {orders.length === 0 ? EMPTY_ROUND_GROUP_TEXT : ordersText(orders.length)}
      </p>
      {orders.length > 0 && (
        <ul className="order-list">
          {orders.map((order) => (
            <RoundOrderCard
              key={order.id}
              order={order}
              confirm={
                groupKey === 'pending'
                  ? {
                      saving: savingIds.has(order.id),
                      failed: failedIds.has(order.id),
                      onConfirm: () => onConfirm(order.id),
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The "אישר בטלפון" part of a card in "עוד לא אישרו". */
interface CardConfirm {
  saving: boolean;
  failed: boolean;
  onConfirm: () => void;
}

/**
 * One order of the round: who, the phone as a link that dials (to ask a customer who has not
 * answered), the street, the bottles, and its tags (in "ביקשו מועד אחר", why it left the round and
 * the day). The customer's name is the card's `<h4>`, under the group's `<h3>`.
 */
function RoundOrderCard({ order, confirm }: { order: CollectorOrder; confirm?: CardConfirm }) {
  const { contact, address } = order;
  const tags = orderTags(order);

  return (
    <li className="order-card">
      <h4 className="order-card-name">{contact.name}</h4>
      <p>
        <a className="order-card-phone" href={`tel:${contact.phone}`}>
          {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
          <bdi dir="ltr">{formatIsraeliMobileLocal(contact.phone)}</bdi>
        </a>
      </p>
      <p>
        {address.streetName} {address.houseNumber}
      </p>
      <p className="order-card-bottles">{bottlesText(order.bottlesEstimated)}</p>
      {tags.length > 0 && (
        <p className="tag-list">
          {tags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </p>
      )}
      {confirm !== undefined && (
        <>
          {/* aria-disabled, not disabled, while saving: the button keeps focus and is announced
              as unavailable; busyIdsRef ignores the extra taps. The hidden rest names the
              customer, so a screen reader's list of buttons tells the cards apart; the visible
              words start the name, as WCAG 2.5.3 (label in name) asks. */}
          <button
            type="button"
            className="button button-secondary order-card-confirm"
            aria-disabled={confirm.saving ? true : undefined}
            onClick={confirm.onConfirm}
          >
            {confirm.saving ? CONFIRMING_LABEL : CONFIRM_LABEL}
            <span className="visually-hidden">, {contact.name}</span>
          </button>
          {confirm.failed && (
            <p className="field-error" role="alert">
              {CONFIRM_FAILED_MESSAGE}
            </p>
          )}
        </>
      )}
    </li>
  );
}
