// The "סבבים" tab of the collector app (spec §3.6, step 1 "אישורים"): each open round with who
// confirmed, who did not yet, and who asked for another date; the round's "שלח" list of
// confirmation requests (ADR-0003, SendList.tsx); and "אישר בטלפון" for a customer who confirmed
// in a call or in a WhatsApp reply. GET /api/collector/rounds sends the rounds already grouped
// (the shared buildRoundView), so this screen only shows them, and after "אישר בטלפון" it swaps
// in the round as the api answers it. Building the route (step 2) is a later section.
import { useEffect, useId, useRef, useState } from 'react';
import {
  REGION_LABELS,
  ROUND_GROUP_KEYS,
  ROUND_GROUP_LABELS,
  formatDayMonth,
  formatIsraeliMobileLocal,
  type CollectorOrder,
  type RoundGroupKey,
  type RoundOrderGroup,
  type RoundView,
} from '@bottlerun/shared';
import {
  confirmOrderByPhone,
  fetchRounds,
  type ConfirmByPhoneOutcome,
  type RoundsOutcome,
} from '../api.ts';
import { Link, navigate } from '../router.tsx';
import { bottlesText, ordersText } from './OrdersScreen.tsx';
import { orderTags } from './orderTags.ts';
import { SendList, type SendListProps } from './SendList.tsx';

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
  /** Passed to the "שלח" list; undefined keeps SendList's own default (the api). */
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
 * rounds load once per visit to the tab (each visit mounts the screen anew), and again on
 * "לנסות שוב". With none open, it says so and links to the planning screen.
 *
 * A 401 means the session ended: to the login, like the guard in CollectorApp.tsx. A failed load
 * stays here with a retry: a dropped connection is not a logout.
 *
 * "אישר בטלפון" swaps in the round the api answers: the customer moves to "אישרו" and leaves the
 * "שלח" list. When the api says the order can no longer be confirmed, or is no longer in the
 * round, the screen says so under the heading, moves the focus there (the card Yoel tapped may be
 * gone after the reload), and loads the rounds again without blanking them first.
 */
export function RoundsScreen({
  loadRounds = fetchRounds,
  confirmByPhone = confirmOrderByPhone,
  markOpened,
}: RoundsScreenProps) {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the loads asked for after the first ("לנסות שוב", or a reload after a refused
  // "אישר בטלפון"): a new value runs the load below again.
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
          // Keyed by the round's id, so the section, and the "שלח" list in it, stay mounted when
          // "אישר בטלפון" swaps in a new view: the rows Yoel already opened stay marked.
          <RoundSection
            key={view.round.id}
            view={view}
            markOpened={markOpened}
            savingIds={savingIds}
            failedIds={failedIds}
            onConfirm={(orderId) => void confirm(view.round.id, orderId)}
          />
        ))}
    </>
  );
}

/** Props of {@link RoundSection}. */
interface RoundSectionProps {
  view: RoundView;
  markOpened: SendListProps['markOpened'];
  /** Orders whose "אישר בטלפון" is on its way. */
  savingIds: ReadonlySet<string>;
  /** Orders whose last "אישר בטלפון" failed. */
  failedIds: ReadonlySet<string>;
  onConfirm: (orderId: string) => void;
}

/**
 * One open round as a named region (its `<h2>`, the half of the city and the day, labels it), top
 * to bottom: the pickup time and the personal text that went into the requests, the confirmation
 * counts, the "שלח" list, and the three groups of orders. Every group shows, an empty one too, so
 * the layout does not jump as customers confirm.
 */
function RoundSection({ view, markOpened, savingIds, failedIds, onConfirm }: RoundSectionProps) {
  const headingId = useId();
  const { round, groups, sendList } = view;

  return (
    <section className="round" aria-labelledby={headingId}>
      <h2 id={headingId}>
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
    </section>
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
