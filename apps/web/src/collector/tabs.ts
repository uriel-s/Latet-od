// The collector app's three tabs (spec §3 "אפליקציית האוסף": bottom navigation הזמנות | סבבים |
// היסטוריה), and which tab a path under /app/ belongs to. The bottom navigation draws the list;
// the shell picks the screen with `tabForPath`, and inside the orders tab with `ordersView`.

/** One of the three screens the bottom navigation switches between. */
export type CollectorTab = 'orders' | 'rounds' | 'history';

/** A tab as the bottom navigation shows it. */
export interface CollectorTabLink {
  tab: CollectorTab;
  /** The Hebrew label on the tab. */
  label: string;
  /** The URL the tab opens. */
  to: string;
}

/** The tabs in the order of spec §3. In the right-to-left row, the first one is on the right. */
export const COLLECTOR_TABS: readonly CollectorTabLink[] = [
  { tab: 'orders', label: 'הזמנות', to: '/app/orders' },
  { tab: 'rounds', label: 'סבבים', to: '/app/rounds' },
  { tab: 'history', label: 'היסטוריה', to: '/app/history' },
];

/**
 * A screen of the orders tab (spec §3.5): the list of waiting orders, "הוספת הזמנה" for a
 * customer who phoned, "תכנון סבב" from the waiting orders, or "עריכה" of one order, whose `id`
 * is already decoded from the URL.
 */
export type OrdersView =
  { view: 'list' } | { view: 'new' } | { view: 'plan' } | { view: 'edit'; id: string };

/**
 * The screen of the orders tab at a path under `/app/` (the router's `path`: no slashes at
 * either end), or null when the path is not one of the tab's:
 * - `''` and `orders`: the list. `/app` alone is where the login lands, and the orders waiting
 *   for a round are where Yoel's work starts.
 * - `orders/new`: the add screen; `orders/plan`: the planning screen. It plans from the waiting
 *   orders, so it lives in their tab. An order id is a Mongo ObjectId (24 hex digits), so no
 *   order is ever called `new` or `plan`.
 * - `orders/<one segment>`: the edit screen of that order. The list encodes the id into the link
 *   (OrdersScreen.tsx), so the segment is decoded here; a malformed escape (`%E0%A4%A`) is no
 *   order's link and gets null, like a deeper path (`orders/a/b`) or an empty segment.
 */
export function ordersView(path: string): OrdersView | null {
  if (path === '' || path === 'orders') return { view: 'list' };
  if (path === 'orders/new') return { view: 'new' };
  if (path === 'orders/plan') return { view: 'plan' };

  const segments = path.split('/');
  if (segments.length !== 2 || segments[0] !== 'orders') return null;
  const segment = segments[1];
  if (segment === undefined || segment === '') return null;
  try {
    return { view: 'edit', id: decodeURIComponent(segment) };
  } catch {
    // decodeURIComponent throws a URIError on a malformed escape.
    return null;
  }
}

/**
 * The tab of a path under `/app/` (the router's `path`: no slashes at either end), or null when
 * no screen has that path. The orders tab owns every path {@link ordersView} knows: the list, the
 * add and planning screens and an order's edit screen, so the bottom navigation keeps "הזמנות"
 * current on all four. Sections that add deeper paths (such as one round) add them here.
 */
export function tabForPath(path: string): CollectorTab | null {
  if (ordersView(path) !== null) return 'orders';
  switch (path) {
    case 'rounds':
      return 'rounds';
    case 'history':
      return 'history';
    default:
      return null;
  }
}
