// The root component, and the single place routes are listed: the URL path picks a page
// (router.tsx), and every page sits inside the shared Layout (header, main, OSM footer).
import type { ReactNode } from 'react';
import { CollectorApp } from './collector/CollectorApp.tsx';
import { Layout } from './Layout.tsx';
import { OrderFormPage } from './orderForm/OrderFormPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { OrderPage } from './pages/OrderPage.tsx';
import { CollectorPwaHead } from './pwaHead.tsx';
import { matchRoute, useLocation, type Route } from './router.tsx';

/** The whole web app: public form, customer page and collector app, chosen by the URL. */
export function App() {
  const { pathname } = useLocation();
  const route = matchRoute(pathname);
  return (
    <>
      {/* Only the collector app is installable; customers get a plain website (pwaHead.tsx). */}
      {isCollectorRoute(route) && <CollectorPwaHead />}
      <Layout>{pageFor(route)}</Layout>
    </>
  );
}

/**
 * Whether a route belongs to the collector (the login and the app), whose pages carry the
 * "install to home screen" tags. The login counts: Yoel may add the app to his home screen
 * before he has logged in on that phone.
 */
function isCollectorRoute(route: Route): boolean {
  return route.name === 'login' || route.name === 'collector';
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
