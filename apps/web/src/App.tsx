// The root component, and the single place routes are listed: the URL path picks a page
// (router.tsx), and every page sits inside the shared Layout (header, main, OSM footer).
import { useEffect, useRef, type ReactNode } from 'react';
import { APP_NAME } from '@bottlerun/shared';
import { CollectorApp } from './collector/CollectorApp.tsx';
import { Layout } from './Layout.tsx';
import { OrderFormPage } from './orderForm/OrderFormPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { OrderPage } from './pages/OrderPage.tsx';
import { announcePageChange } from './pageChange.ts';
import { matchRoute, useLocation, type Route } from './router.tsx';

/** The whole web app: public form, customer page and collector app, chosen by the URL. */
export function App() {
  const { pathname } = useLocation();
  const isFirstRender = useRef(true);

  // pushState does not do what a page load does: scroll to the top, name the page, tell a screen
  // reader. So after every path change but the first load, this does it (pageChange.ts).
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    announcePageChange(APP_NAME);
  }, [pathname]);

  return <Layout>{pageFor(matchRoute(pathname))}</Layout>;
}

/** The page component for a route. Adding a route means a case here and in `matchRoute`. */
function pageFor(route: Route): ReactNode {
  switch (route.name) {
    case 'orderForm':
      return <OrderFormPage />;
    case 'orderPage':
      // `key`: another token is another order, so the page mounts anew and loads it.
      return <OrderPage key={route.token} token={route.token} />;
    case 'login':
      return <LoginPage />;
    case 'collector':
      // No `key` on purpose: every /app/* path renders the same component at the same place, so
      // switching tabs keeps it mounted, and its login guard checks the session only once.
      return <CollectorApp path={route.path} />;
    case 'notFound':
      return <NotFoundPage />;
  }
}
