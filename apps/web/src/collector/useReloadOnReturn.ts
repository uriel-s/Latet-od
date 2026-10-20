// Reloads a screen's data when Yoel comes back to the app (ADR-0006). Installed to the home screen,
// the collector app has no address bar and no pull-to-refresh, so without this a list he left open
// in the background keeps showing what it loaded hours ago. Only the list screens (OrdersScreen,
// RoundsScreen) use it; never the add, edit or plan screens, where a reload would wipe what he typed.
// For the same reason RoundsScreen's callback skips the reload while a route's quantity field is open.
import { useEffect, useRef } from 'react';

/**
 * Calls `reload` each time the page becomes visible again (`visibilitychange` with
 * `document.visibilityState === 'visible'`): Yoel switched back to the app or unlocked the phone.
 * Not on mount, since the screen's own first load covers that, and not when the page is hidden.
 *
 * The newest `reload` is kept in a ref, so an inline arrow function neither re-subscribes the
 * listener on every render nor runs a stale callback.
 */
export function useReloadOnReturn(reload: () => void): void {
  const reloadRef = useRef(reload);

  // Updated in an effect rather than during render: writing a ref while rendering is not allowed.
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') reloadRef.current();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}
