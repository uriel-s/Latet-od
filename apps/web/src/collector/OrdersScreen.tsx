// The "הזמנות" tab of the collector app (spec §3.5): the orders waiting for a round, in the three
// groups of GET /api/collector/orders (רמת בית שמש, בית שמש, בלי אזור), each with its order count
// and bottle total, and each order as a card with its tags (orderTags.ts) and an "עריכה" link.
// "הוספת הזמנה" and "עריכה" lead to /app/orders/new and /app/orders/<id>, the add and edit screens
// built from the booking form's parts (OrderFields); "תכנון סבב" leads to /app/orders/plan
// (PlanRoundScreen.tsx). The cards here only show.
import { useEffect, useId, useState } from 'react';
import {
  BOTTLES_SPOT_LABELS,
  ORDER_GROUP_LABELS,
  findStreet,
  formatIsraeliMobileLocal,
  type CollectorOrder,
  type OrderGroup,
} from '@bottlerun/shared';
import { fetchWaitingOrders, type WaitingOrdersOutcome } from '../api.ts';
import { Link, navigate } from '../router.tsx';
import { orderTags } from './orderTags.ts';

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
 * instead of adding a path segment or a query (the same rule as api.ts's request paths).
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
 * "בקבוק אחד", "40 בקבוקים". A real order has at least 30, but a count of one still reads right.
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

/** Props of {@link OrdersScreen}. */
export interface OrdersScreenProps {
  /**
   * Loads the waiting orders. Defaults to {@link fetchWaitingOrders}; tests pass a fake. Must keep
   * its identity across renders (a module function, not an inline arrow): a new one loads again.
   */
  loadOrders?: () => Promise<WaitingOrdersOutcome>;
}

/** What the screen shows. A logged-out answer leaves for /login and needs no state of its own. */
type ScreenState =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; groups: OrderGroup[] };

/**
 * The orders tab. Renders the page's only `<h1>` (Layout's heading rule) in every state, and the
 * "הוספת הזמנה" and "תכנון סבב" links right under it: a customer who phones while the list loads,
 * or while the connection is down, can still be added, and the planning screen loads its own
 * list. The list loads once per visit to the tab (each visit mounts the screen anew), and again
 * when Yoel taps "לנסות שוב".
 *
 * A 401 means the session ended (expired, or logged out on another tab): to the login, like the
 * guard in CollectorApp.tsx. A failed load stays here with a retry: a dropped connection is not a
 * logout.
 */
export function OrdersScreen({ loadOrders = fetchWaitingOrders }: OrdersScreenProps) {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  // Counts the "לנסות שוב" taps: a new value runs the load below again.
  const [attempt, setAttempt] = useState(0);

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
      <Link to={ADD_ORDER_PATH} className="button button-primary button-block orders-add">
        הוספת הזמנה
      </Link>
      <Link to={PLAN_ROUND_PATH} className="button button-secondary button-block orders-plan">
        תכנון סבב
      </Link>

      {state.kind === 'loading' && <p role="status">טוען...</p>}

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

      {state.kind === 'loaded' &&
        state.groups.map((group) => <OrderGroupSection key={group.key} group={group} />)}
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
      <p className="order-group-summary">{groupSummary(group)}</p>
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
 * One waiting order: who, how to reach them, where the bottles wait and how many, its tags, and
 * the link to edit it. The customer's name is the card's `<h3>`, so a screen reader can jump from
 * order to order.
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
    <li className="order-card">
      <h3 className="order-card-name">{contact.name}</h3>
      <p>
        {/* Digits and hyphens read left to right inside the right-to-left text (CLAUDE.md). */}
        <bdi dir="ltr">{formatIsraeliMobileLocal(contact.phone)}</bdi>
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
      {/* The visible word alone would be "עריכה" in every card; the hidden rest names the
          customer, so a screen reader's list of links tells the cards apart. The visible word
          starts the name, as WCAG 2.5.3 (label in name) asks, so voice control finds it. */}
      <Link to={editOrderPath(order.id)} className="button button-secondary order-card-edit">
        עריכה<span className="visually-hidden">, ההזמנה של {contact.name}</span>
      </Link>
    </li>
  );
}
