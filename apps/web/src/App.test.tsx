import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_ORDER_MESSAGES,
  groupWaitingOrders,
  type CollectorOrdersResponse,
  type CustomerOrderResponse,
  type MeResponse,
  type RoundsResponse,
} from '@bottlerun/shared';
import { act } from '@testing-library/react';
import { App } from './App.tsx';
import { navigate } from './router.tsx';

/** One path for each route, with the heading its page settles on, for the checks every page must pass. */
const ONE_PATH_PER_ROUTE: [path: string, heading: string][] = [
  ['/', 'הזמנת איסוף בקבוקים'],
  // No order has the token "abc": the page settles on "not found", under its own heading.
  ['/o/abc', 'ההזמנה שלך'],
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

/** GET /api/collector/rounds: no round is open, and none was planned before. */
const NO_OPEN_ROUNDS_BODY: RoundsResponse = { rounds: [] };

/** The token of the one order the fake api knows: 43 base64url characters, like a real one. */
const CANCELLED_ORDER_TOKEN = 'c'.repeat(43);

/** GET /api/o/<CANCELLED_ORDER_TOKEN>: a cancelled order, as its customer's page gets it. */
const CANCELLED_ORDER_BODY: CustomerOrderResponse = {
  order: {
    contact: { name: 'רחל כהן', phone: '+972501234567' },
    address: { streetName: 'הרימון', houseNumber: '7', bottlesSpot: 'privateHouse' },
    bottlesEstimated: 45,
    status: 'cancelled',
  },
};

/** A 200 whose body is `body` as JSON. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stands in for the api in every test of this file, so no page sends a real request from jsdom.
 * The collector app's guard calls it (GET /api/auth/me), and so do its orders tab (GET
 * /api/collector/orders) and its rounds tab (GET /api/collector/rounds); the customer's page asks
 * for its order (GET /api/o/:token), which only CANCELLED_ORDER_TOKEN finds. Anything else gets a
 * 404.
 */
function fakeApi(input: string): Promise<Response> {
  requests.push(input);
  if (input === '/api/collector/orders') {
    return Promise.resolve(jsonResponse(NO_WAITING_ORDERS_BODY));
  }
  if (input === '/api/collector/rounds') {
    return Promise.resolve(jsonResponse(NO_OPEN_ROUNDS_BODY));
  }
  if (input === `/api/o/${CANCELLED_ORDER_TOKEN}`) {
    return Promise.resolve(jsonResponse(CANCELLED_ORDER_BODY));
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
 * Renders the app at `path`, waits for its page's `<h1>` (the collector app shows it only after its
 * session check), then for the page's own load to finish (the customer's page and the rounds tab
 * show "טוען..." until their answer comes). The per-route checks below must not race either: an
 * answer drawn after a test ended is an update outside act().
 */
async function renderSettledAt(path: string, heading: string): Promise<void> {
  renderAt(path);
  await screen.findByRole('heading', { level: 1, name: heading });
  await waitFor(() => expect(screen.queryByText('טוען...')).toBeNull());
}

describe('App', () => {
  it('after an in-app navigation, scrolls to the top, titles the tab and focuses the heading', () => {
    renderAt('/');
    // The first load is the browser's own business: no focus is moved.
    expect(document.activeElement).toBe(document.body);

    act(() => navigate('/login'));

    const heading = screen.getByRole('heading', { level: 1, name: 'כניסה' });
    expect(document.activeElement).toBe(heading);
    expect(document.title).toBe('כניסה | לתת עוד');
    // The spy comes from testSetup.ts; spying again returns it.
    expect(vi.spyOn(window, 'scrollTo')).toHaveBeenCalledWith(0, 0);
  });

  it('shows the booking form at /', () => {
    renderAt('/');

    expect(screen.getByRole('heading', { level: 1, name: 'הזמנת איסוף בקבוקים' })).toBeDefined();
  });

  it('shows the order page at /o/<token>, asking the api for that token', async () => {
    renderAt('/o/abc');

    expect(screen.getByRole('heading', { level: 1, name: 'ההזמנה שלך' })).toBeDefined();
    // The fake api knows no order "abc".
    expect((await screen.findByRole('alert')).textContent).toBe(
      CUSTOMER_ORDER_MESSAGES.orderNotFound,
    );
    expect(requests).toEqual(['/api/o/abc']);
  });

  it('opens the booking form filled in from "הזמנה חדשה עם אותם פרטים" on the order page', async () => {
    renderAt(`/o/${CANCELLED_ORDER_TOKEN}`);

    fireEvent.click(await screen.findByRole('button', { name: 'הזמנה חדשה עם אותם פרטים' }));

    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { level: 1, name: 'הזמנת איסוף בקבוקים' })).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('שם').value).toBe('רחל כהן');
    expect(screen.getByLabelText<HTMLInputElement>('טלפון נייד').value).toBe('050-1234567');
    expect(screen.getByLabelText<HTMLInputElement>('מספר בית').value).toBe('7');
    // Never the bottles: they differ from one order to the next.
    expect(screen.getByLabelText<HTMLInputElement>('כמות בקבוקים').value).toBe('');
  });

  it('shows the login page at /login', () => {
    renderAt('/login');

    expect(screen.getByRole('heading', { level: 1, name: 'כניסה' })).toBeDefined();
  });

  it('shows the collector app at /app and the paths under it once logged in', async () => {
    renderAt('/app/rounds');

    expect(await screen.findByRole('heading', { level: 1, name: 'סבבים' })).toBeDefined();
    expect(screen.getByRole('navigation', { name: 'ניווט באפליקציה' })).toBeDefined();
    // The session check, then the rounds tab's own list once it is shown.
    expect(await screen.findByText('אין סבב פתוח.')).toBeDefined();
    expect(requests).toEqual(['/api/auth/me', '/api/collector/rounds']);
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
    // The session once, and each visited tab's own list once (the rounds tab loads its rounds even
    // though Yoel moved on at once); no tab switch checks the session.
    await waitFor(() =>
      expect(requests).toEqual(['/api/auth/me', '/api/collector/orders', '/api/collector/rounds']),
    );
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
