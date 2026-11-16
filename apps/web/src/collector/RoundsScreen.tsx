// The "סבבים" tab (spec §3.6): ONE open round at a time, its id in the URL as `?round=<id>`;
// without it, or with an id no longer open, the nearest open round shows. Only open rounds are
// listed. GET /api/collector/rounds sends rounds already grouped and routed (shared
// buildRoundView); this screen shows them and swaps in the round an action returns.
// Question components own only open state and focus; the requests and their double-tap guard
// (useRoundAction.ts) stay with this screen.
import { EmptyState } from '../components/EmptyState.tsx';
import { LoadFailed } from '../components/LoadFailed.tsx';
import { Skeleton } from '../components/Skeleton.tsx';
import { useEffect, useRef, useState } from 'react';
import { ROUND_MESSAGES, type RoundView } from '@bottlerun/shared';
import { useApi } from '../api/ApiContext.tsx';
import type { RoundsOutcome } from '../api/roundsApi.ts';
import { Link, navigate, searchParam, useLocation } from '../router.tsx';
import { FlashNotice } from './FlashNotice.tsx';
import { pickSelectedRound } from './roundPicker.ts';
import { RoundPicker } from './RoundPickerSheet.tsx';
import { RoundSection } from './RoundSection.tsx';
import { useReloadOnReturn } from './useReloadOnReturn.ts';
import { useRoundAction } from './useRoundAction.ts';

/** Shown when the rounds got no usable answer (network error, 5xx, unreadable body). */
export const ROUNDS_LOAD_FAILED_MESSAGE =
  'לא הצלחנו לטעון את הסבבים. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** In place of the rounds when none is open, above the link to plan one. */
export const NO_OPEN_ROUND_TEXT = 'אין סבב פתוח.';

/**
 * Under the heading once the close button answered: the round left the tab (only open rounds are listed),
 * so the section Yoel tapped is gone and the focus comes here.
 */
export const ROUND_CLOSED_MESSAGE = 'הסבב נסגר.';

/** Where "תכנון סבב" leads when no round is open (PlanRoundScreen.tsx). */
const PLAN_ROUND_PATH = '/app/orders/plan';

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
  // "התחל מסלול" and the close button, by round id. A new request clears an old notice first.
  const buildAction = useRoundAction(buildRoute, () => setNotice(undefined));
  const closeAction = useRoundAction(closeRound, () => setNotice(undefined));
  // The rounds closed on this screen. A load answer is filtered through it: a reload that started
  // before the close answered still lists the round, and must not bring it back. A closed round
  // never opens again, so the set only grows while the screen is shown.
  const closedRoundIdsRef = useRef(new Set<string>());
  // The routed rounds with a quantity field open (RouteScreen's onTypingChange). A ref, not state:
  // only the reload-on-return callback reads it, and a change must not re-render the screen.
  const typingRoundIdsRef = useRef(new Set<string>());
  const noticeRef = useRef<HTMLParagraphElement>(null);

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
  function buildRouteOf(roundId: string): Promise<void> {
    return buildAction.run(roundId, (outcome) => {
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
      }
    });
  }

  /** Yoel's "yes" to the close question for round `roundId`, in either phase (spec §3.6). */
  function closeRoundOf(roundId: string): Promise<void> {
    return closeAction.run(roundId, (outcome) => {
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
      }
    });
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
        <LoadFailed message={ROUNDS_LOAD_FAILED_MESSAGE} onRetry={retry} />
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
              building: buildAction.busyIds.has(selected.round.id),
              failed: buildAction.failedIds.has(selected.round.id),
              onBuild: () => void buildRouteOf(selected.round.id),
              onOpenChange: () => buildAction.clearFailed(selected.round.id),
            }}
            closeRound={{
              closing: closeAction.busyIds.has(selected.round.id),
              failed: closeAction.failedIds.has(selected.round.id),
              onClose: () => void closeRoundOf(selected.round.id),
              onOpenChange: () => closeAction.clearFailed(selected.round.id),
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
