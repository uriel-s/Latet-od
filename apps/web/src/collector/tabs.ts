// The collector app's three tabs (spec §3 "אפליקציית האוסף": bottom navigation הזמנות | סבבים |
// היסטוריה), and which tab a path under /app/ belongs to. The bottom navigation draws the list;
// the shell picks the screen with `tabForPath`.

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
 * The tab of a path under `/app/` (the router's `path`: no slashes at either end), or null when
 * no screen has that path. `/app` alone is the orders tab: it is where the login lands, and the
 * orders waiting for a round are where Yoel's work starts. Sections that add deeper paths (such
 * as one round) add them here.
 */
export function tabForPath(path: string): CollectorTab | null {
  switch (path) {
    case '':
    case 'orders':
      return 'orders';
    case 'rounds':
      return 'rounds';
    case 'history':
      return 'history';
    default:
      return null;
  }
}
