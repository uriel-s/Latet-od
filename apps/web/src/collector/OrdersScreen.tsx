// The "הזמנות" tab of the collector app (spec §3.5): the orders waiting for a round, in the three
// groups of GET /api/collector/orders (רמת בית שמש, בית שמש, בלי אזור), each with its order count
// and bottle total, and each order as a card with its tags (orderTags.ts), an "עריכה" link and a
// WhatsApp "הודעה" link.
// "הוספת הזמנה" and "עריכה" lead to /app/orders/new and /app/orders/<id>, the add and edit screens
// built from the booking form's parts (OrderFields); "תכנון סבב" leads to /app/orders/plan
// (PlanRoundScreen.tsx). The cards here only show.
import { EmptyState } from '../components/EmptyState.tsx';
import { Skeleton } from '../components/Skeleton.tsx';
import { useEffect, useId, useState } from 'react';
import {
  BOTTLES_SPOT_LABELS,
  ORDER_GROUP_LABELS,
  findStreet,
  formatDayMonthTime,
  formatIsraeliMobileLocal,
  waMeChatUrl,
  type CollectorOrder,
  type OrderGroup,
} from '@bottlerun/shared';
import { useApi } from '../api/ApiContext.tsx';
import type { WaitingOrdersOutcome } from '../api/collectorOrdersApi.ts';
import { Link, navigate } from '../router.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { FlashNotice } from './FlashNotice.tsx';
import { PushNotificationsControl } from './PushNotificationsControl.tsx';
import { orderTags } from './orderTags.ts';
import { useReloadOnReturn } from './useReloadOnReturn.ts';

/** Shown when the list got no usable answer (network error, 5xx, unreadable body). */
export const ORDERS_LOAD_FAILED_MESSAGE =
  'לא הצלחנו לטעון את ההזמנות. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** The summary of a group with no orders, in place of its count, total and list. */
export const EMPTY_GROUP_TEXT = 'אין הזמנות שממתינות';

/** Where "הוספת הזמנה" leads: the add screen for a customer who phoned (spec §3.5). */
const ADD_ORDER_PATH = '/app/orders/new';

/** Where "תכנון סבב" leads: a round planned from the waiting orders of one region (spec §3.5). */
const PLAN_ROUND_PATH = '/app/orders/plan';

/**
 * The edit screen of one order. The id is encoded, so a `/` or `?` in it stays part of the id
 * instead of adding a path segment or a query (the same rule as collectorOrdersApi.ts's request paths).
 */
function editOrderPath(id: string): string {
  return `/app/orders/${encodeURIComponent(id)}`;
}

/**
 * "הזמנה אחת", "3 הזמנות": Hebrew says "one" after the noun, and the plural from two up. The
 * rounds tab's groups use it too, so both tabs count orders the same way.
 */
export function ordersText(count: number): string {
  return count === 1 ? 'הזמנה אחת' : `${count} הזמנות`;
}

/**
 * "בקבוק אחד", "40 בקבוקים". A real order has at least 20, but a count of one still reads right.
 * The planning screen's order rows use it too, so a card and a row say the count the same way.
 */
export function bottlesText(count: number): string {
  return count === 1 ? 'בקבוק אחד' : `${count} בקבוקים`;
}

/**
 * The line under a group's title (spec §3.5: per region, the number of orders and the bottle
 * total), e.g. "3 הזמנות · 120 בקבוקים"; {@link EMPTY_GROUP_TEXT} for a group with no orders, which
 * the screen still shows so its layout does not jump between visits.
 */
export function groupSummary(group: Pick<OrderGroup, 'orderCount' | 'bottlesTotal'>): string {
  if (group.orderCount === 0) return EMPTY_GROUP_TEXT;
  return `${ordersText(group.orderCount)} · ${bottlesText(group.bottlesTotal)}`;
}

/**
 * The line at the top of the loaded list (ADR-0011): all waiting orders and the bottles in them,
 * e.g. "12 ממתינות · כ־340 בקבוקים". Summed from the groups already loaded, so it costs no request.
 * "כ־" because the bottle counts are estimates. {@link EMPTY_GROUP_TEXT} when no order waits.
 */
export function waitingSummary(groups: readonly OrderGroup[]): string {
  const orders = groups.reduce((sum, group) => sum + group.orderCount, 0);
  const bottles = groups.reduce((sum, group) => sum + group.bottlesTotal, 0);
  if (orders === 0) return EMPTY_GROUP_TEXT;
  const waiting = orders === 1 ? 'ממתינה אחת' : `${orders} ממתינות`;
  return `${waiting} · כ־${bottlesText(bottles)}`;
}

/** What the screen shows. A logged-out answer leaves for /login and needs no state of its own. */
type ScreenState =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; groups: OrderGroup[] };

/**
 * The orders tab. Renders the page's only `<h1>` (Layout's heading rule) in every state, and the
 * "הוספת הזמנה" and "תכנון סבב" links right under it: a customer who phones while the list loads,
 * or while the connection is down, can still be added, and the planning screen loads its own
 * list. The list loads once per visit to the tab (each visit mounts the screen anew), again when
 * Yoel taps "לנסות שוב", and again when he comes back to the app ({@link useReloadOnReturn}: the
 * installed app has no pull-to-refresh). That last reload keeps what is shown, the list or the
 * failure message, until its answer replaces it: no "טוען..." in between, nothing jumps.
 *
 * A 401 means the session ended (expired, or logged out on another tab): to the login, like the
 * guard in CollectorApp.tsx. A failed load stays here with a retry: a dropped connection is not a
 * logout.
 *
 * The list comes from `fetchWaitingOrders` of {@link useApi} (GET /api/collector/orders).
 */
export function OrdersScreen() {
  // The client keeps its functions' identity, so this effect dependency does not reload.
  const { fetchWaitingOrders: loadOrders } = useApi();
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the loads asked for after the first ("לנסות שוב", or Yoel coming back to the app): a
  // new value runs the load below again.
  const [attempt, setAttempt] = useState(0);

  // Back in the app: load again without blanking the screen first, unlike retry().
  useReloadOnReturn(() => {
    setAttempt((previous) => previous + 1);
  });

  useEffect(() => {
    // False once this load's answer no longer matters: Yoel left the tab, a retry started a newer
    // load, or React's StrictMode ran the effect a second time (dev only). A stale answer changes
    // nothing; above all, a late "logged out" must not pull him to the login from another screen.
    let current = true;

    function settle(outcome: WaitingOrdersOutcome): void {
      if (!current) return;
      switch (outcome.kind) {
        case 'loaded':
          setState({ kind: 'loaded', groups: outcome.groups });
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

    // fetchWaitingOrders never rejects; a rejection is a failed load like any other.
    loadOrders().then(settle, () => settle({ kind: 'failed' }));
    return () => {
      current = false;
    };
  }, [loadOrders, attempt]);

  function retry(): void {
    setState({ kind: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  return (
    <>
      <h1>הזמנות</h1>
      {/* What the screen Yoel just left did ("ההזמנה נשמרה"): its form is gone, so this tells it. */}
      <FlashNotice />
      <PushNotificationsControl />
      {/* Side by side in one row of two columns, like an app's action bar (mockup §2). */}
      <div className="orders-actions">
        <Link to={ADD_ORDER_PATH} className="button button-primary button-block">
          הוספת הזמנה
        </Link>
        <Link to={PLAN_ROUND_PATH} className="button button-secondary button-block">
          תכנון סבב
        </Link>
      </div>

      {state.kind === 'loading' && <Skeleton />}

      {state.kind === 'failed' && (
        <>
          <p className="form-alert" role="alert">
            {ORDERS_LOAD_FAILED_MESSAGE}
          </p>
          <button type="button" className="button button-primary button-block" onClick={retry}>
            לנסות שוב
          </button>
        </>
      )}

      {state.kind === 'loaded' && <LoadedOrders groups={state.groups} />}
    </>
  );
}

/**
 * The loaded list. When no order waits in any group, one {@link EmptyState} says so, in place of
 * the summary line and an empty state for each of the three groups (the same sentence four times
 * said nothing more). With at least one order, the summary and all three groups show, an empty
 * group with its own empty state, so the groups keep their places between visits.
 */
function LoadedOrders({ groups }: { groups: OrderGroup[] }) {
  const anyWaiting = groups.some((group) => group.orderCount > 0);
  if (!anyWaiting) return <EmptyState icon="list" text={EMPTY_GROUP_TEXT} />;

  return (
    <>
      <p className="orders-summary">{waitingSummary(groups)}</p>
      {groups.map((group) => (
        <OrderGroupSection key={group.key} group={group} />
      ))}
    </>
  );
}

/**
 * One group as a named region (its `<h2>` labels it), so a screen reader lists the three groups
 * as landmarks and can jump between them. The summary sits right under the title; an empty group
 * shows {@link EMPTY_GROUP_TEXT} and no list.
 */
function OrderGroupSection({ group }: { group: OrderGroup }) {
  const headingId = useId();

  return (
    <section className="order-group" aria-labelledby={headingId}>
      <h2 id={headingId}>{ORDER_GROUP_LABELS[group.key]}</h2>
      {group.orders.length === 0 ? (
        <EmptyState icon="list" text={groupSummary(group)} />
      ) : (
        <p className="order-group-summary">{groupSummary(group)}</p>
      )}
      {group.orders.length > 0 && (
        <ul className="order-list">
          {group.orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One waiting order: who, how to reach them, when they booked, where the bottles wait and how
 * many, its tags, and the links to edit it or open a WhatsApp chat. The customer's name is the
 * card's `<h3>`, so a screen reader can jump from order to order.
 */
function OrderCard({ order }: { order: CollectorOrder }) {
  const { contact, address } = order;
  // Where at the address: the spot in the form's words, then the floor and apartment if given.
  const spot = [BOTTLES_SPOT_LABELS[address.bottlesSpot], address.floorApt]
    .filter((part) => part !== undefined)
    .join(' · ');
  // The near street was checked against the list when Yoel picked it; a code that has since left
  // the list has no name to show, and the "בלי מיקום" tag already says what to fix.
  const nearStreet =
    address.nearStreetCode === undefined ? undefined : findStreet(address.nearStreetCode);
  const tags = orderTags(order);

  return (
    <li className="card orders-card">
      <div className="orders-card-head">
        <h3 className="order-card-name">{contact.name}</h3>
        {/* Every order in this list waits for a round; the badge makes the status readable. */}
        <StatusBadge status={order.status} />
      </div>
      <p>
        {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
        <bdi dir="ltr">{formatIsraeliMobileLocal(contact.phone)}</bdi>
      </p>
      <p>
        {/* DD/MM · HH:MM in Israel time reads left to right inside the right-to-left text. */}
        <bdi dir="ltr">{formatDayMonthTime(order.createdAt)}</bdi>
      </p>
      <p>
        {address.streetName} {address.houseNumber}
      </p>
      <p>{spot}</p>
      {nearStreet !== undefined && <p>רחוב קרוב: {nearStreet.name}</p>}
      {address.note !== undefined && <p>הערה: {address.note}</p>}
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
      {/* The visible words alone would be "עריכה" and "הודעה" in every card; the hidden rest names
          the customer, so a screen reader's list of links tells the cards apart. The visible word
          starts the name, as WCAG 2.5.3 (label in name) asks, so voice control finds it. */}
      <div className="order-card-actions">
        <Link to={editOrderPath(order.id)} className="button button-secondary order-card-edit">
          עריכה<span className="visually-hidden">, ההזמנה של {contact.name}</span>
        </Link>
        <a
          href={waMeChatUrl(contact.phone)}
          target="_blank"
          rel="noopener noreferrer"
          className="button button-secondary order-card-edit"
        >
          הודעה<span className="visually-hidden">, ההזמנה של {contact.name}</span>
        </a>
      </div>
    </li>
  );
}
