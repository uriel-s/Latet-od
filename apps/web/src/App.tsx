// The root component, and the single place routes are listed: the URL path picks a page
// (router.tsx), and every page sits inside the shared Layout (header, main, OSM footer).
import type { ReactNode } from 'react';
import { Layout } from './Layout.tsx';
import { OrderFormPage } from './orderForm/OrderFormPage.tsx';
import { CollectorPage } from './pages/CollectorPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { OrderPage } from './pages/OrderPage.tsx';
import { matchRoute, useLocation, type Route } from './router.tsx';

/** The whole web app: public form, customer page and collector app, chosen by the URL. */
export function App() {
  const { pathname } = useLocation();
  return <Layout>{pageFor(matchRoute(pathname))}</Layout>;
}

/** The page component for a route. Adding a route means a case here and in `matchRoute`. */
function pageFor(route: Route): ReactNode {
  switch (route.name) {
    case 'orderForm':
      return <OrderFormPage />;
    case 'orderPage':
      // Section 9 passes `route.token` to the real page.
      return <OrderPage />;
    case 'login':
      return <LoginPage />;
    case 'collector':
      // Section 5 passes `route.path` to choose the tab.
      return <CollectorPage />;
    case 'notFound':
      return <NotFoundPage />;
  }
}
