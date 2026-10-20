import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  groupWaitingOrders,
  type CollectorOrdersResponse,
  type MeResponse,
} from '@bottlerun/shared';
import { App } from './App.tsx';

/** One path for each route, with the heading its page settles on, for the checks every page must pass. */
const ONE_PATH_PER_ROUTE: [path: string, heading: string][] = [
  ['/', 'הזמנת איסוף בקבוקים'],
  ['/o/abc', 'עמוד ההזמנה'],
  ['/login', 'כניסה'],
  ['/app/rounds', 'סבבים'],
  ['/no-such-page', 'העמוד לא נמצא'],
];

const LOGGED_IN_BODY: MeResponse = { user: { sub: 'collector' } };

/** The paths of every request the app sent in this test, in order. */
let requests: string[] = [];
/** Whether the fake api says this browser is logged in (GET /api/auth/me). */
let loggedIn = true;

/** GET /api/collector/orders: no order is waiting. */
const NO_WAITING_ORDERS_BODY: CollectorOrdersResponse = { groups: groupWaitingOrders([]) };

/**
 * Stands in for the api in every test of this file, so no page sends a real request from jsdom.
 * The collector app's guard calls it (GET /api/auth/me), and so does its orders tab (GET
 * /api/collector/orders); anything else gets a 404.
 */
function fakeApi(input: string): Promise<Response> {
  requests.push(input);
  if (input === '/api/collector/orders') {
    return Promise.resolve(
      new Response(JSON.stringify(NO_WAITING_ORDERS_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  if (input !== '/api/auth/me') return Promise.resolve(new Response(null, { status: 404 }));
  return Promise.resolve(
    loggedIn
      ? new Response(JSON.stringify(LOGGED_IN_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
  );
}

beforeEach(() => {
  requests = [];
  loggedIn = true;
  vi.stubGlobal('fetch', fakeApi);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders the app as if the browser had opened `path`. */
function renderAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<App />);
}

/**
 * Renders the app at `path` and waits for its page's `<h1>`: the collector app shows it only
 * after its session check, which the per-route checks below must not race.
 */
async function renderSettledAt(path: string, heading: string): Promise<void> {
  renderAt(path);
  await screen.findByRole('heading', { level: 1, name: heading });
}

describe('App', () => {
  it('shows the booking form at /', () => {
    renderAt('/');

    expect(screen.getByRole('heading', { level: 1, name: 'הזמנת איסוף בקבוקים' })).toBeDefined();
  });

  it('shows the order page at /o/<token>', () => {
    renderAt('/o/abc');

    expect(screen.getByRole('heading', { level: 1, name: 'עמוד ההזמנה' })).toBeDefined();
  });

  it('shows the login page at /login', () => {
    renderAt('/login');

    expect(screen.getByRole('heading', { level: 1, name: 'כניסה' })).toBeDefined();
  });

  it('shows the collector app at /app and the paths under it once logged in', async () => {
    renderAt('/app/rounds');

    expect(await screen.findByRole('heading', { level: 1, name: 'סבבים' })).toBeDefined();
    expect(screen.getByRole('navigation', { name: 'ניווט באפליקציה' })).toBeDefined();
    expect(requests).toEqual(['/api/auth/me']);
  });

  it('sends a logged-out visitor of /app to the login', async () => {
    loggedIn = false;
    renderAt('/app/rounds');

    expect(await screen.findByRole('heading', { level: 1, name: 'כניסה' })).toBeDefined();
    expect(window.location.pathname).toBe('/login');
  });

  it('keeps the collector app open across tabs, checking the session once', async () => {
    renderAt('/app/orders');
    await screen.findByRole('heading', { level: 1, name: 'הזמנות' });

    fireEvent.click(screen.getByRole('link', { name: 'סבבים' }));
    fireEvent.click(screen.getByRole('link', { name: 'היסטוריה' }));

    expect(screen.getByRole('heading', { level: 1, name: 'היסטוריה' })).toBeDefined();
    expect(window.location.pathname).toBe('/app/history');
    // The session once, and the orders tab's own list once; no tab switch checks the session.
    await waitFor(() => expect(requests).toEqual(['/api/auth/me', '/api/collector/orders']));
  });

  it('shows "page not found" for an unknown path', () => {
    renderAt('/no-such-page');

    expect(screen.getByRole('heading', { level: 1, name: 'העמוד לא נמצא' })).toBeDefined();
  });

  it('leads from "page not found" back to the booking form', () => {
    renderAt('/o/');

    fireEvent.click(screen.getByRole('link', { name: 'לטופס ההזמנה' }));

    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { level: 1, name: 'הזמנת איסוף בקבוקים' })).toBeDefined();
  });

  it.each(ONE_PATH_PER_ROUTE)(
    'credits OpenStreetMap in the footer at %s',
    async (path, heading) => {
      await renderSettledAt(path, heading);

      const footer = screen.getByRole('contentinfo');
      const credit = within(footer).getByRole('link', { name: '© OpenStreetMap contributors' });
      expect(credit.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
    },
  );

  it.each(ONE_PATH_PER_ROUTE)('shows the app name and slogan at %s', async (path, heading) => {
    await renderSettledAt(path, heading);

    const header = screen.getByRole('banner');
    expect(within(header).getByText('לתת עוד')).toBeDefined();
    expect(within(header).getByText('הבקבוקים שלכם, התפילין שלהם!')).toBeDefined();
  });

  it.each(ONE_PATH_PER_ROUTE)(
    'renders exactly one h1, inside main, at %s',
    async (path, heading) => {
      await renderSettledAt(path, heading);

      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(within(screen.getByRole('main')).getByRole('heading', { level: 1 })).toBeDefined();
    },
  );

  it('renders exactly one h1, inside main, while the collector app checks the session', async () => {
    renderAt('/app/rounds');

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      within(screen.getByRole('main')).getByRole('heading', {
        level: 1,
        name: 'אפליקציית האוסף',
      }),
    ).toBeDefined();
    // Let the check finish inside the test, not after it.
    await screen.findByRole('heading', { level: 1, name: 'סבבים' });
  });
});
