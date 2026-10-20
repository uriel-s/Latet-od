// The collector app once the guard (CollectorApp.tsx) knows Yoel is logged in: the logout action
// at the top, the screen of the current URL, and the bottom navigation (spec §3 "אפליקציית
// האוסף"). Switching tabs only changes `path`; this component and its guard stay mounted.
import { useRef, useState, type ReactNode } from 'react';
import { navigate } from '../router.tsx';
import { AddOrderScreen } from './AddOrderScreen.tsx';
import { BottomNav } from './BottomNav.tsx';
import { CollectorNotFound } from './CollectorNotFound.tsx';
import { EditOrderScreen } from './EditOrderScreen.tsx';
import { HistoryScreen } from './HistoryScreen.tsx';
import { OrdersScreen } from './OrdersScreen.tsx';
import { PlanRoundScreen } from './PlanRoundScreen.tsx';
import { RoundsScreen } from './RoundsScreen.tsx';
import { ordersView, tabForPath, type CollectorTab, type OrdersView } from './tabs.ts';

const LOGOUT_LABEL = 'יציאה';
const LOGGING_OUT_LABEL = 'יוצא...';

/** Props of {@link CollectorShell}. */
export interface CollectorShellProps {
  /** The rest of the URL after `/app/`, without slashes at either end (router.tsx). */
  path: string;
  /** Ends the session (POST /api/auth/logout); true when the api confirmed it. */
  logOut: () => Promise<boolean>;
}

/**
 * The logged-in collector app. The screen comes from `path`, and each screen renders the page's
 * only `<h1>` (Layout's heading rule); a path no screen has shows "העמוד לא נמצא" inside the app.
 */
export function CollectorShell({ path, logOut }: CollectorShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  // The state above reaches the handler only after a re-render; this ref stops a second tap
  // that comes before it, so the logout request is sent once.
  const loggingOutRef = useRef(false);
  const tab = tabForPath(path);

  async function leave(): Promise<void> {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    setLoggingOut(true);
    try {
      await logOut();
    } catch {
      // logout never rejects; a rejection is treated like any other failed logout below.
    }
    // To the login whatever the answer. If the request failed, the cookie may still be set (it is
    // httpOnly: only the api can clear it), and the next visit to /app opens the app again
    // without a password. Kept that simple on purpose: a retry screen would leave Yoel on a
    // screen of the app he asked to leave, and the phone is his own.
    // Replace, not push: "back" from the login must not return to the app screen just left.
    navigate('/login', { replace: true });
  }

  return (
    <>
      <div className="collector-toolbar">
        {/* aria-disabled, not disabled, while the request runs: the button keeps focus and is
            announced as unavailable; loggingOutRef ignores the extra taps. */}
        <button
          type="button"
          className="link-button collector-logout"
          aria-disabled={loggingOut ? true : undefined}
          onClick={() => void leave()}
        >
          {loggingOut ? LOGGING_OUT_LABEL : LOGOUT_LABEL}
        </button>
      </div>

      {screenFor(tab, path)}

      <BottomNav activeTab={tab} />
    </>
  );
}

/**
 * The screen of a tab at `path`; a null tab is a path no screen has. The orders tab has four
 * screens (the list, add, plan and edit), all under the one tab "הזמנות". The rounds tab shows the
 * open rounds and their confirmations; the history screen stays a placeholder until its section.
 */
function screenFor(tab: CollectorTab | null, path: string): ReactNode {
  switch (tab) {
    case 'orders':
      return ordersScreenFor(ordersView(path));
    case 'rounds':
      return <RoundsScreen />;
    case 'history':
      return <HistoryScreen />;
    case null:
      return <CollectorNotFound />;
  }
}

/** The screen of the orders tab (spec §3.5). */
function ordersScreenFor(view: OrdersView | null): ReactNode {
  // tabForPath gives the orders tab only to paths ordersView knows, so null does not happen here;
  // it is handled anyway rather than asserted away.
  if (view === null) return <CollectorNotFound />;
  switch (view.view) {
    case 'list':
      return <OrdersScreen />;
    case 'new':
      return <AddOrderScreen />;
    case 'plan':
      return <PlanRoundScreen />;
    case 'edit':
      // The key mounts the screen anew for another order (from one edit link to another): it
      // loads that order, and its street pickers, which read their value only when they mount,
      // show that order's streets.
      return <EditOrderScreen key={view.id} id={view.id} />;
  }
}
