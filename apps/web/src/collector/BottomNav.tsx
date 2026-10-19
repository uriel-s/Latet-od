// The collector app's bottom navigation (spec §3): הזמנות | סבבים | היסטוריה. Fixed to the bottom
// of the screen (styles.css `.bottom-nav`), so the tabs stay under Yoel's thumb on every screen.
import { Link } from '../router.tsx';
import { COLLECTOR_TABS, type CollectorTab } from './tabs.ts';

/**
 * The three tabs as links, in a `<nav>` that screen readers list as "ניווט באפליקציה". The link
 * of `activeTab` carries `aria-current="page"`: announced as the current page, and styled by a bar
 * and a background, not by colour alone. `activeTab` is null on a screen of no tab (not found).
 */
export function BottomNav({ activeTab }: { activeTab: CollectorTab | null }) {
  return (
    <nav className="bottom-nav" aria-label="ניווט באפליקציה">
      <ul className="bottom-nav-list">
        {COLLECTOR_TABS.map(({ tab, label, to }) => (
          <li key={tab}>
            <Link
              to={to}
              className="bottom-nav-link"
              aria-current={tab === activeTab ? 'page' : undefined}
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
