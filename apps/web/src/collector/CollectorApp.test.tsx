import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupWaitingOrders, type CollectorOrdersResponse } from '@bottlerun/shared';
import type { SessionOutcome } from '../api.ts';
import { matchRoute, useLocation } from '../router.tsx';
import { CollectorApp, SESSION_CHECK_FAILED_MESSAGE } from './CollectorApp.tsx';

const LOGGED_IN: SessionOutcome = { kind: 'loggedIn', user: { sub: 'collector' } };
const LOGGED_OUT: SessionOutcome = { kind: 'loggedOut' };
const FAILED: SessionOutcome = { kind: 'failed' };

/**
 * The orders tab loads its list with the real fetchWaitingOrders (CollectorShell passes no fake),
 * so every test here stubs the global fetch: GET /api/collector/orders answers an empty list, and
 * no test sends a request from jsdom. The session itself is checked by the fake loadSession.
 */
function fakeApi(input: string): Promise<Response> {
  if (input !== '/api/collector/orders')
    return Promise.resolve(new Response(null, { status: 404 }));
  const body: CollectorOrdersResponse = { groups: groupWaitingOrders([]) };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fakeApi);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A promise the test settles by hand, to look at the screen while its request is on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A fake `loadSession`: answers each call with the next answer given (the last one repeats). */
function fakeSession(...answers: (SessionOutcome | Promise<SessionOutcome>)[]): {
  load: () => Promise<SessionOutcome>;
  calls: () => number;
} {
  let calls = 0;
  const load = (): Promise<SessionOutcome> => {
    const answer = answers[Math.min(calls, answers.length - 1)] ?? LOGGED_IN;
    calls += 1;
    return Promise.resolve(answer);
  };
  return { load, calls: () => calls };
}

/** A fake `logOut` that records how often it was called and answers `succeeded`. */
function fakeLogout(succeeded = true): { logOut: () => Promise<boolean>; calls: () => number } {
  let calls = 0;
  return {
    logOut: () => {
      calls += 1;
      return Promise.resolve(succeeded);
    },
    calls: () => calls,
  };
}

/**
 * Opens `path` the way App.tsx does: the collector app while the URL is under /app (the same
 * mounted component for every tab), and a plain marker for any other page, such as /login.
 */
function renderAt(
  path: string,
  loadSession: () => Promise<SessionOutcome>,
  logOut: () => Promise<boolean> = fakeLogout().logOut,
  { strict = false }: { strict?: boolean } = {},
): { unmount: () => void } {
  window.history.replaceState(null, '', path);
  function Pages() {
    const route = matchRoute(useLocation().pathname);
    return route.name === 'collector' ? (
      <CollectorApp path={route.path} loadSession={loadSession} logOut={logOut} />
    ) : (
      <p>עמוד אחר</p>
    );
  }
  return render(
    strict ? (
      <StrictMode>
        <Pages />
      </StrictMode>
    ) : (
      <Pages />
    ),
  );
}

/** The bottom navigation. */
function bottomNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'ניווט באפליקציה' });
}

/** The names of the links in the bottom navigation, in document order. */
function tabNames(): string[] {
  return within(bottomNav())
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');
}

/** The links of the bottom navigation marked as the current page. */
function currentTabs(): string[] {
  return within(bottomNav())
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent ?? '');
}

describe('CollectorApp', () => {
  describe('while the session check runs', () => {
    it('shows the app name as the heading and a loading status, without the navigation', () => {
      renderAt('/app/rounds', () => deferred<SessionOutcome>().promise);

      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1, name: 'אפליקציית האוסף' })).toBeDefined();
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('navigation')).toBeNull();
      expect(screen.queryByRole('button', { name: 'יציאה' })).toBeNull();
    });
  });

  describe('logged in', () => {
    it('shows the screen of the path, the logout action and the three tabs in order', async () => {
      renderAt('/app/rounds', fakeSession(LOGGED_IN).load);

      expect(await screen.findByRole('heading', { level: 1, name: 'סבבים' })).toBeDefined();
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByRole('button', { name: 'יציאה' })).toBeDefined();
      expect(tabNames()).toEqual(['הזמנות', 'סבבים', 'היסטוריה']);
      expect(currentTabs()).toEqual(['סבבים']);
    });

    it('links each tab to its own path', async () => {
      renderAt('/app', fakeSession(LOGGED_IN).load);
      await screen.findByRole('navigation', { name: 'ניווט באפליקציה' });

      const hrefs = within(bottomNav())
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'));
      expect(hrefs).toEqual(['/app/orders', '/app/rounds', '/app/history']);
    });

    // `shows`: a text only that screen has, so the screen itself is on, not just its heading.
    it.each([
      ['/app', 'הזמנות', 'הזמנות', 'הוספת הזמנה'],
      ['/app/', 'הזמנות', 'הזמנות', 'הוספת הזמנה'],
      ['/app/orders', 'הזמנות', 'הזמנות', 'הוספת הזמנה'],
      ['/app/rounds', 'סבבים', 'סבבים', 'בקרוב.'],
      ['/app/history', 'היסטוריה', 'היסטוריה', 'בקרוב.'],
    ])(
      'at %s shows the screen "%s" with the tab "%s" current',
      async (path, heading, tab, shows) => {
        renderAt(path, fakeSession(LOGGED_IN).load);

        expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeDefined();
        expect(screen.getByText(shows)).toBeDefined();
        expect(currentTabs()).toEqual([tab]);
      },
    );

    it('shows "page not found" inside the app for an unknown path, with a way to the orders', async () => {
      renderAt('/app/no-such-screen', fakeSession(LOGGED_IN).load);

      expect(await screen.findByRole('heading', { level: 1, name: 'העמוד לא נמצא' })).toBeDefined();
      expect(currentTabs()).toEqual([]);
      expect(tabNames()).toEqual(['הזמנות', 'סבבים', 'היסטוריה']);

      fireEvent.click(screen.getByRole('link', { name: 'להזמנות' }));

      expect(window.location.pathname).toBe('/app/orders');
      expect(screen.getByRole('heading', { level: 1, name: 'הזמנות' })).toBeDefined();
    });

    it('switches screens from the navigation without checking the session again', async () => {
      const session = fakeSession(LOGGED_IN);
      renderAt('/app/orders', session.load);
      await screen.findByRole('heading', { level: 1, name: 'הזמנות' });

      fireEvent.click(within(bottomNav()).getByRole('link', { name: 'היסטוריה' }));

      expect(window.location.pathname).toBe('/app/history');
      expect(screen.getByRole('heading', { level: 1, name: 'היסטוריה' })).toBeDefined();
      expect(currentTabs()).toEqual(['היסטוריה']);

      fireEvent.click(within(bottomNav()).getByRole('link', { name: 'סבבים' }));

      expect(screen.getByRole('heading', { level: 1, name: 'סבבים' })).toBeDefined();
      expect(screen.queryByRole('status')).toBeNull();
      // Let any check that was (wrongly) started settle before counting.
      await new Promise((settle) => setTimeout(settle, 0));
      expect(session.calls()).toBe(1);
    });
  });

  describe('logged out', () => {
    it('goes to the login in place of the guarded page', async () => {
      const historyLength = window.history.length;
      renderAt('/app/rounds', fakeSession(LOGGED_OUT).load);

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      // Replaced, not pushed: "back" from the login does not bounce off /app again.
      expect(window.history.length).toBe(historyLength);
      expect(screen.getByText('עמוד אחר')).toBeDefined();
    });

    it('stays where the visitor went when the answer comes after leaving the app', async () => {
      const answer = deferred<SessionOutcome>();
      const { unmount } = renderAt('/app/rounds', () => answer.promise);
      unmount();
      window.history.replaceState(null, '', '/');

      answer.resolve(LOGGED_OUT);
      await new Promise((settle) => setTimeout(settle, 0));

      expect(window.location.pathname).toBe('/');
    });
  });

  describe('when the session check fails', () => {
    it('says so in plain words with a retry, and stays on the page', async () => {
      const session = fakeSession(FAILED);
      renderAt('/app/rounds', session.load);

      expect((await screen.findByRole('alert')).textContent).toBe(SESSION_CHECK_FAILED_MESSAGE);
      expect(screen.getByRole('heading', { level: 1, name: 'אפליקציית האוסף' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'לנסות שוב' })).toBeDefined();
      expect(screen.queryByRole('navigation')).toBeNull();
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('treats a rejected check like a failed one', async () => {
      renderAt('/app/rounds', () => Promise.reject(new Error('boom')));

      expect((await screen.findByRole('alert')).textContent).toBe(SESSION_CHECK_FAILED_MESSAGE);
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('checks again on "לנסות שוב", and opens the app when the check now succeeds', async () => {
      const second = deferred<SessionOutcome>();
      const session = fakeSession(FAILED, second.promise);
      renderAt('/app/rounds', session.load);
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(session.calls()).toBe(2);
      expect(screen.getByRole('status').textContent).toBe('טוען...');
      expect(screen.queryByRole('alert')).toBeNull();

      second.resolve(LOGGED_IN);

      expect(await screen.findByRole('heading', { level: 1, name: 'סבבים' })).toBeDefined();
      expect(window.location.pathname).toBe('/app/rounds');
    });

    it('shows the retry again when the second check fails too', async () => {
      const session = fakeSession(FAILED, FAILED);
      renderAt('/app/rounds', session.load);
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'לנסות שוב' }));

      expect(await screen.findByRole('button', { name: 'לנסות שוב' })).toBeDefined();
      expect(session.calls()).toBe(2);
      expect(window.location.pathname).toBe('/app/rounds');
    });
  });

  describe('in StrictMode (development)', () => {
    it('ignores the answer of the first, discarded run of the check', async () => {
      // StrictMode mounts, unmounts and mounts again: two checks, and only the second counts.
      const session = fakeSession(LOGGED_OUT, LOGGED_IN);
      renderAt('/app/orders', session.load, undefined, { strict: true });

      expect(await screen.findByRole('heading', { level: 1, name: 'הזמנות' })).toBeDefined();
      expect(session.calls()).toBe(2);
      expect(window.location.pathname).toBe('/app/orders');
    });
  });

  describe('logout', () => {
    it('logs out once and goes to the login in place of the app', async () => {
      const logout = fakeLogout(true);
      renderAt('/app/rounds', fakeSession(LOGGED_IN).load, logout.logOut);
      const button = await screen.findByRole('button', { name: 'יציאה' });
      const historyLength = window.history.length;

      fireEvent.click(button);

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(logout.calls()).toBe(1);
      expect(window.history.length).toBe(historyLength);
    });

    it('says "logging out" while the request runs and ignores a second tap', async () => {
      const answer = deferred<boolean>();
      let calls = 0;
      const logOut = (): Promise<boolean> => {
        calls += 1;
        return answer.promise;
      };
      renderAt('/app/rounds', fakeSession(LOGGED_IN).load, logOut);
      fireEvent.click(await screen.findByRole('button', { name: 'יציאה' }));

      const busy = screen.getByRole('button', { name: 'יוצא...' });
      expect(busy.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(busy);
      expect(calls).toBe(1);
      expect(window.location.pathname).toBe('/app/rounds');

      answer.resolve(true);
      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(calls).toBe(1);
    });

    it('goes to the login even when the logout request failed', async () => {
      const logout = fakeLogout(false);
      renderAt('/app/rounds', fakeSession(LOGGED_IN).load, logout.logOut);

      fireEvent.click(await screen.findByRole('button', { name: 'יציאה' }));

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(logout.calls()).toBe(1);
    });

    it('goes to the login even when logOut rejects', async () => {
      renderAt('/app/rounds', fakeSession(LOGGED_IN).load, () => Promise.reject(new Error('boom')));

      fireEvent.click(await screen.findByRole('button', { name: 'יציאה' }));

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
    });
  });
});
