// The "סבבים" tab of the collector app (spec §3.6): ONE open round at a time. A picker above it
// (RoundPickerSheet.tsx) switches rounds when more than one is open; the chosen round's id lives in
// the URL as `?round=<id>`, and without it (or with an id that is not open any more) the nearest
// open round shows. Only open rounds are listed, so a closed round is never an option.
// Step 1 "תכנון" (phase `confirming`, a name from before ADR-0012): who is in the round and who
// asked for another date; the round's "שלח" list of messages (ADR-0003, SendList.tsx), which only
// announce the pickup (nobody confirms, ADR-0012); and "התחל מסלול", asked as a question first
// (BuildRouteConfirm.tsx). Step 2 "מסלול" (phase `routed`): the route's
// stops (RouteScreen.tsx). In both steps the round ends with its close button (CloseRoundConfirm.tsx),
// after which it leaves the tab. GET /api/collector/rounds sends the open rounds already grouped
// and routed (the shared buildRoundView), so this screen only shows them, and after each action it
// swaps in the round as the api answers it. The question components own only their open state and
// focus; this screen sends every request and keeps its double-tap guards.
import { EmptyState } from '../components/EmptyState.tsx';
import { Icon } from '../components/Icon.tsx';
import { Skeleton } from '../components/Skeleton.tsx';
import { useEffect, useId, useRef, useState } from 'react';
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
import { useApi } from '../api/ApiContext.tsx';
import type { BuildRouteOutcome, CloseRoundOutcome, RoundsOutcome } from '../api/roundsApi.ts';
import { Link, navigate, searchParam, useLocation } from '../router.tsx';
import {
  BuildRouteConfirm,
  buildRouteQuestion,
  type BuildRouteControl,
} from './BuildRouteConfirm.tsx';
import { CloseRoundConfirm, type CloseRoundConfirmProps } from './CloseRoundConfirm.tsx';
import { FlashNotice } from './FlashNotice.tsx';
import { bottlesText, ordersText } from './OrdersScreen.tsx';
import { orderTags } from './orderTags.ts';
import { pickSelectedRound } from './roundPicker.ts';
import { RoundPicker } from './RoundPickerSheet.tsx';
import { RouteScreen, type RouteScreenProps } from './RouteScreen.tsx';
import { SendList } from './SendList.tsx';
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

/** The heading of the round's "שלח" list in step 1. */
export const SEND_LIST_HEADING = 'הודעות ללקוחות';

/**
 * The colour of each group's count tile and badge (the `round-tile-*` / `badge-*` suffix): green for
 * the customers in the round, gray for another date. Decoration only: the words say which count it
 * is.
 */
const GROUP_COLOURS: Readonly<Record<RoundGroupKey, 'green' | 'gray'>> = {
  inRound: 'green',
  otherDate: 'gray',
};

/**
 * Under the heading once the close button answered: the round left the tab (only open rounds are listed),
 * so the section Yoel tapped is gone and the focus comes here.
 */
export const ROUND_CLOSED_MESSAGE = 'הסבב נסגר.';

/** Where "תכנון סבב" leads when no round is open (PlanRoundScreen.tsx). */
const PLAN_ROUND_PATH = '/app/orders/plan';

/**
 * The orders of the group `key`, as the api listed them (plan order). The api always sends every
 * group; a missing one shows as empty rather than breaking the screen.
 */
function ordersOfGroup(groups: readonly RoundOrderGroup[], key: RoundGroupKey): CollectorOrder[] {
  return groups.find((group) => group.key === key)?.orders ?? [];
}

/**
 * The round's groups at a glance, in words and in {@link ROUND_GROUP_KEYS} order, e.g.
 * "בסבב: 5 · ביקשו מועד אחר: 1".
 */
export function roundGroupsSummary(groups: readonly RoundOrderGroup[]): string {
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
 * Only one round is shown, the one `?round=<id>` names, else the first the api listed (the nearest
 * date: {@link pickSelectedRound}). With two or more open, {@link RoundPicker} sits above it and
 * choosing a round writes `?round=<id>` with `replace`, so the choice survives a reload and a
 * return from WhatsApp without adding history entries. The default is never written to the URL.
 * The other rounds' state (building, closing, typing) is kept by round id, so an action still
 * answering for a round that is not on screen finds its way back when Yoel returns to it.
 *
 * A 401 means the session ended: to the login, like the guard in CollectorApp.tsx. A failed load
 * stays here with a retry: a dropped connection is not a logout.
 *
 * "התחל מסלול" swaps in the routed round the api answers, so the section shows its route in place
 * of step 1. A route already built, or a round gone, means the screen is out of date: the screen
 * says so under the heading, moves the focus there, and loads the rounds again without blanking
 * them first. Each stop action of the route is sent by
 * RouteScreen; this screen swaps in its answer, or shows its notice and reloads.
 *
 * The close button takes the closed round off the screen and says {@link ROUND_CLOSED_MESSAGE} under the
 * heading, with the focus there, since the section Yoel tapped is gone. No reload: the answer is
 * the truth already, and a closed round is never listed again. A reload that set out before the
 * close answered may still list the round, so every loaded answer leaves out the rounds closed
 * here. The selection then falls back to the first round left (the URL still names the closed
 * one, which is simply not open any more). With none left, "אין סבב פתוח." and the planning link
 * show, as after any load.
 *
 * The reload on coming back is skipped while a quantity field of "אספתי" is open: a reload must
 * never wipe what Yoel types (a failed load replaces the rounds, and a stop handled elsewhere
 * closes its field). The usual trip away mid-route is to Waze or the dialler; once the field is
 * closed, the next return reloads as before. Picking another round while a field is open unmounts
 * that round's route, which reports "not typing" on its way out, so the pause cannot outlast it.
 *
 * The screen's own requests are `fetchRounds`, `buildRoute` and `closeRound` of {@link useApi}.
 * The stop actions are RouteScreen's and the "שלח" rows' are SendList's: each part takes its own
 * from the client, so none passes through this screen.
 */
export function RoundsScreen() {
  // The client keeps its functions' identity, so listing `loadRounds` as an effect dependency does
  // not run the load again.
  const { fetchRounds: loadRounds, buildRoute, closeRound } = useApi();
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the loads asked for after the first ("לנסות שוב", a reload after a refused action, or
  // Yoel coming back to the app): a new value runs the load below again.
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // The rounds whose route build is on its way ("מתחיל מסלול..."), and those whose last one failed,
  // by round id. The state reaches the handler only after a re-render; the ref stops a second tap
  // that comes before it, so one tap sends one request.
  const [buildingIds, setBuildingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [buildFailedIds, setBuildFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const buildingIdsRef = useRef(new Set<string>());
  // The same three for the close button, by round id.
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [closeFailedIds, setCloseFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const closingIdsRef = useRef(new Set<string>());
  // The rounds closed on this screen. A load answer is filtered through it: a reload that started
  // before the close answered still lists the round, and must not bring it back. A closed round
  // never opens again, so the set only grows while the screen is shown.
  const closedRoundIdsRef = useRef(new Set<string>());
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
          setState({
            kind: 'loaded',
            rounds: outcome.rounds.filter((view) => !closedRoundIdsRef.current.has(view.round.id)),
          });
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
  // his next action or "לנסות שוב" clears it, as before. Skipped while he is typing a
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

  /** Takes round `roundId` off the screen, now and from every later load (closedRoundIdsRef). */
  function removeRound(roundId: string): void {
    closedRoundIdsRef.current.add(roundId);
    setState((previous) =>
      previous.kind === 'loaded'
        ? { kind: 'loaded', rounds: previous.rounds.filter((shown) => shown.round.id !== roundId) }
        : previous,
    );
  }

  /** Yoel's "כן, להתחיל" for round `roundId` (spec §3.6, "התחל מסלול"). */
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
      // buildRoute never rejects, but a rejection must not leave the question on "מתחיל מסלול...".
      outcome = { kind: 'failed' };
    }
    buildingIdsRef.current.delete(roundId);
    if (!mountedRef.current) return;
    setBuildingIds((previous) => withId(previous, roundId, false));

    switch (outcome.kind) {
      case 'built':
        // Phase `routed`: the section shows the route in place of step 1.
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

  /** Yoel's "yes" to the close question for round `roundId`, in either phase (spec §3.6). */
  async function closeRoundOf(roundId: string): Promise<void> {
    if (closingIdsRef.current.has(roundId)) return;
    closingIdsRef.current.add(roundId);
    setClosingIds((previous) => withId(previous, roundId, true));
    setCloseFailedIds((previous) => withId(previous, roundId, false));
    setNotice(undefined);

    let outcome: CloseRoundOutcome;
    try {
      outcome = await closeRound(roundId);
    } catch {
      // closeRound never rejects, but a rejection must not leave the question on its busy label.
      outcome = { kind: 'failed' };
    }
    closingIdsRef.current.delete(roundId);
    if (!mountedRef.current) return;
    setClosingIds((previous) => withId(previous, roundId, false));

    switch (outcome.kind) {
      case 'closed':
        // Off the tab, which lists open rounds only; the notice takes the focus of the section.
        removeRound(roundId);
        setNotice({ message: ROUND_CLOSED_MESSAGE });
        return;
      case 'notFound':
        showStale(ROUND_MESSAGES.roundNotFound);
        return;
      case 'loggedOut':
        navigate('/login', { replace: true });
        return;
      case 'failed':
        // Nothing to reload: the request may not have arrived. The question stays open for "כן".
        setCloseFailedIds((previous) => withId(previous, roundId, true));
        return;
    }
  }

  // The round on screen: the `?round=` of the URL, else the nearest open one. A stale or unknown
  // id (a round closed meanwhile, an old link) falls back the same way, and the URL is not
  // rewritten for it: the query is written only when Yoel picks a round himself.
  const { pathname, search } = useLocation();
  const selected =
    state.kind === 'loaded'
      ? pickSelectedRound(state.rounds, searchParam(search, 'round'))
      : undefined;

  /**
   * Yoel picked `roundId` in the picker. Only the query changes, on the page he is on; `replace`,
   * so choosing a round does not pile up history entries for the back button to walk through.
   */
  function selectRound(roundId: string): void {
    navigate(`${pathname}?round=${encodeURIComponent(roundId)}`, { replace: true });
  }

  return (
    <>
      <h1>סבבים</h1>

      <FlashNotice />

      {notice !== undefined && (
        // tabIndex -1: focusable from code only (the effect above), never a Tab stop.
        <p ref={noticeRef} className="form-alert" role="alert" tabIndex={-1}>
          {notice.message}
        </p>
      )}

      {state.kind === 'loading' && <Skeleton />}

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
        <EmptyState
          icon="calendar"
          text={NO_OPEN_ROUND_TEXT}
          action={
            <Link to={PLAN_ROUND_PATH} className="button button-primary button-block">
              תכנון סבב
            </Link>
          }
        />
      )}

      {state.kind === 'loaded' && selected !== undefined && (
        <>
          {/* Renders nothing for a single round: there is nothing to choose. */}
          <RoundPicker
            rounds={state.rounds}
            selectedId={selected.round.id}
            onSelect={selectRound}
          />
          {/* Keyed by the round's id, so the section, and the "שלח" list or the route in it, stay
              mounted when an action swaps in a new view: the rows Yoel already opened stay marked,
              and an open quantity field stays open. Picking another round mounts that round's
              section anew, and RouteScreen's unmount tells typingChanged the field is gone. */}
          <RoundSection
            key={selected.round.id}
            view={selected}
            buildRoute={{
              building: buildingIds.has(selected.round.id),
              failed: buildFailedIds.has(selected.round.id),
              onBuild: () => void buildRouteOf(selected.round.id),
              onOpenChange: () =>
                setBuildFailedIds((previous) => withId(previous, selected.round.id, false)),
            }}
            closeRound={{
              closing: closingIds.has(selected.round.id),
              failed: closeFailedIds.has(selected.round.id),
              onClose: () => void closeRoundOf(selected.round.id),
              onOpenChange: () =>
                setCloseFailedIds((previous) => withId(previous, selected.round.id, false)),
            }}
            route={{
              // A saved stop action: its answer replaces the round, and an old notice has served.
              onView: (next) => {
                setNotice(undefined);
                replaceRound(next);
              },
              onStale: showStale,
              onTypingChange: (typing) => typingChanged(selected.round.id, typing),
            }}
          />
        </>
      )}
    </>
  );
}

/**
 * What a section needs for the close button, in either phase: everything of {@link CloseRoundConfirm}
 * but the view, which the section has already. The screen sends the request.
 */
type SectionCloseRound = Omit<CloseRoundConfirmProps, 'view'>;

/** What a step-2 section passes to its {@link RouteScreen}: everything but the view. */
type SectionRoute = Omit<RouteScreenProps, 'view'>;

/** Props of {@link RoundSection}. */
interface RoundSectionProps {
  view: RoundView;
  /** Step 1's last button. */
  buildRoute: BuildRouteControl;
  /** Step 2's route. */
  route: SectionRoute;
  /** The close button, the last button of either step. */
  closeRound: SectionCloseRound;
}

/**
 * One open round as a named region (its `<h2>`, the half of the city and the day, labels it), top
 * to bottom: the pickup times and the personal text that went into the messages, then the round's
 * step (spec §3.6).
 *
 * Step 1 (phase `confirming`): the heading, the pickup times (with a clock icon) and the personal
 * text sit in ONE details card, which ends with coloured count tiles (בסבב / ביקשו מועד אחר). The
 * tiles are aria-hidden: a visually hidden live sentence ({@link roundGroupsSummary}) says the same
 * counts in words, so a screen reader hears them once and hears the new counts after a reload. Then
 * the grouped "שלח" list, the groups of orders as grouped lists (every group shows, an empty one
 * too, so the layout does not jump), and last "התחל מסלול": the step that ends step 1 comes after
 * everything Yoel checks before it. Nobody has to confirm (ADR-0012), so there is no "did not
 * confirm" group and no "confirmed by phone" button.
 *
 * Step 2 (phase `routed`): the route alone, under the heading and texts as plain lines (no card,
 * no tiles). Its own summary takes the place of the group counts (one live summary per round, not
 * two), and the groups and the "שלח" list are gone.
 *
 * The details wrapper is rendered in both steps (only its class changes), so the `<h2>` stays
 * mounted across the build and the focus effect below can still reach it.
 *
 * Both steps end with the close button (CloseRoundConfirm.tsx), after the step's own last part (the
 * build question, or the route), so the quieter way out of the round comes after the way on. It
 * is rendered outside the step's branch, at one place in the section, so an open question (and the
 * thank-you rows Yoel tapped in it) stays mounted across every swapped view, a build included.
 *
 * When a build swaps step 1 for step 2, the question Yoel answered is gone, so the focus goes to
 * the round's heading, at the top of its route. Only when the focus was lost that way (on the page
 * itself, or still in this section): a notice the screen focused meanwhile keeps it, and so does
 * an open close question, which stays where it was.
 */
function RoundSection({ view, buildRoute, route, closeRound }: RoundSectionProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLDivElement>(null);
  const { round, groups, sendList } = view;
  const routed = round.phase === 'routed';
  const wasRoutedRef = useRef(routed);

  useEffect(() => {
    const becameRouted = routed && !wasRoutedRef.current;
    wasRoutedRef.current = routed;
    if (!becameRouted) return;
    const active = document.activeElement;
    const focusLost =
      active === null ||
      active === document.body ||
      (sectionRef.current?.contains(active) === true &&
        closeRef.current?.contains(active) !== true);
    if (focusLost) headingRef.current?.focus();
  }, [routed]);

  // With both times, the start is when the bottles must be out AND when Yoel starts coming; the
  // window is his arrival (ADR-0012), as the customers' message says it.
  const pickupText =
    round.pickupBy === undefined ? null : round.pickupFrom !== undefined ? (
      <>
        להוציא את הבקבוקים עד <bdi dir="ltr">{round.pickupFrom}</bdi> · מגיעים בין{' '}
        <bdi dir="ltr">{round.pickupFrom}</bdi> ל-<bdi dir="ltr">{round.pickupBy}</bdi>
      </>
    ) : (
      <>
        להוציא את הבקבוקים עד <bdi dir="ltr">{round.pickupBy}</bdi>
      </>
    );

  return (
    <section ref={sectionRef} className="round" aria-labelledby={headingId}>
      {/* Always rendered, so the h2 inside stays mounted across the build (see the effect above);
          a card only in step 1; step 2 keeps the plain lines above its route. */}
      <div className={routed ? undefined : 'card round-details'}>
        {/* tabIndex -1: focused from code after the route is built, never a Tab stop. */}
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          {REGION_LABELS[round.region]} ·{' '}
          {/* DD/MM reads left to right inside the right-to-left text (CLAUDE.md). */}
          <bdi dir="ltr">{formatDayMonth(round.date)}</bdi>
        </h2>
        {pickupText !== null &&
          (routed ? (
            <p>{pickupText}</p>
          ) : (
            <p className="round-pickup">
              <Icon name="clock" />
              <span>{pickupText}</span>
            </p>
          ))}
        {round.personalText !== undefined && (
          <p className="round-personal-text">טקסט אישי: {round.personalText}</p>
        )}

        {!routed && (
          <>
            {/* Polite live text: a screen reader hears the new counts after a reload. Hidden,
                because the tiles below show the same counts to the eye. */}
            <p className="round-summary visually-hidden" aria-live="polite">
              {roundGroupsSummary(groups)}
            </p>
            {/* The same counts as coloured tiles; aria-hidden so they are not read twice. */}
            <div className="round-tiles" aria-hidden="true">
              {ROUND_GROUP_KEYS.map((key) => (
                <div key={key} className={`round-tile round-tile-${GROUP_COLOURS[key]}`}>
                  <b>{ordersOfGroup(groups, key).length}</b>
                  <span>{ROUND_GROUP_LABELS[key]}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {routed ? (
        // Not keyed by anything that changes: it stays mounted across every swapped view, so an
        // open quantity field and the "שלח תודה" rows Yoel tapped stay as they are.
        <RouteScreen view={view} {...route} />
      ) : (
        <>
          <h3>{SEND_LIST_HEADING}</h3>
          {sendList.length > 0 && <p className="round-hint">{SEND_LIST_HINT}</p>}
          {/* Always rendered at this place, so it stays mounted across a swapped view; it shows its
              own text when no message is left to send. */}
          <SendList rows={sendList} grouped />

          {ROUND_GROUP_KEYS.map((key) => (
            <RoundGroupSection key={key} groupKey={key} orders={ordersOfGroup(groups, key)} />
          ))}

          <BuildRouteConfirm
            question={buildRouteQuestion(ordersOfGroup(groups, 'inRound').length)}
            {...buildRoute}
          />
        </>
      )}

      {/* Outside the branch above, so it stays mounted when the build swaps the step. The wrapper
          lets the effect above tell focus in this question from focus lost. */}
      <div ref={closeRef}>
        <CloseRoundConfirm view={view} {...closeRound} />
      </div>
    </section>
  );
}

/** Props of {@link RoundGroupSection}. */
interface RoundGroupSectionProps {
  groupKey: RoundGroupKey;
  orders: readonly CollectorOrder[];
}

/**
 * One group of the round ("בסבב", "ביקשו מועד אחר") as a named region: its title
 * with a coloured count badge next to it, then ONE grouped-list card with a thin row per order, or
 * a quiet card with {@link EMPTY_ROUND_GROUP_TEXT} and no list. The badge is aria-hidden (a bare
 * number), so a visually hidden "2 הזמנות" beside it says the count in words; it sits outside the
 * `<h3>`, so the region's name stays the group's title.
 */
function RoundGroupSection({ groupKey, orders }: RoundGroupSectionProps) {
  const headingId = useId();

  return (
    <section className="round-group" aria-labelledby={headingId}>
      <div className="group-head">
        <h3 id={headingId}>{ROUND_GROUP_LABELS[groupKey]}</h3>
        <span className={`badge badge-${GROUP_COLOURS[groupKey]}`} aria-hidden="true">
          {orders.length}
        </span>
        {orders.length > 0 && <span className="visually-hidden">{ordersText(orders.length)}</span>}
      </div>
      {orders.length === 0 ? (
        <p className="card grouped-empty">{EMPTY_ROUND_GROUP_TEXT}</p>
      ) : (
        <ul className="card grouped-list">
          {orders.map((order) => (
            <RoundOrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One order of the round as a thin row of its group's list: the customer's name (the row's `<h4>`,
 * under the group's `<h3>`) over "street · bottles", and at the row's end a round call button that
 * dials. Under them, on a full line: its tags (in "ביקשו מועד אחר", why it left the round and the
 * day). The call button shows only a phone icon; the number, visually
 * hidden inside it, is its accessible name.
 */
function RoundOrderCard({ order }: { order: CollectorOrder }) {
  const { contact, address } = order;
  const tags = orderTags(order);

  return (
    <li className="grouped-row">
      <div className="grouped-row-main">
        <h4 className="grouped-row-title">{contact.name}</h4>
        <p className="grouped-row-meta">
          <span>
            {address.streetName} {address.houseNumber}
          </span>
          {' · '}
          <span>{bottlesText(order.bottlesEstimated)}</span>
        </p>
      </div>
      <a className="call-button" href={`tel:${contact.phone}`}>
        <Icon name="phone" />
        {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
        <span className="visually-hidden">
          <bdi dir="ltr">{formatIsraeliMobileLocal(contact.phone)}</bdi>
        </span>
      </a>
      {tags.length > 0 && (
        <p className="tag-list grouped-row-full">
          {tags.map((tag) => (
            <span key={tag} className="badge">
              {tag}
            </span>
          ))}
        </p>
      )}
    </li>
  );
}
