// A minimal client-side router on the browser's History API. No router dependency on purpose
// (CLAUDE.md: minimum moving parts): the app has four routes and no nested layouts or data
// loaders, which this file covers in a few dozen lines. App.tsx is the one place routes are listed.
//
// The server (the SPA rewrite `/(.*)` → `/index.html` in vercel.json; Vite's dev server does the
// same) answers every non-/api path that is not a built file with index.html, so a deep link such
// as /o/<token> from a WhatsApp message loads the app, and `matchRoute` picks the page.
import { useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';

/** A page of the app, decided by the URL path alone. */
export type Route =
  /** `/`: the public booking form (spec §3.1). */
  | { name: 'orderForm' }
  /** `/o/<token>`: the customer's own order page (spec §3.3, section 9). */
  | { name: 'orderPage'; token: string }
  /** `/login`: the collector's login (spec §3.4, section 5). */
  | { name: 'login' }
  /**
   * `/app` and everything under it: the collector app (section 5). `path` is the rest after
   * `/app/`, without slashes at either end: `/app` → `''`, `/app/rounds/` → `'rounds'`.
   */
  | { name: 'collector'; path: string }
  /** Any other path. */
  | { name: 'notFound' };

// One non-empty segment of base64url characters, optionally followed by a slash. Whether it is a
// real token is the api's question (section 9); here it only has to look like one path segment.
const ORDER_PAGE_PATH = /^\/o\/([A-Za-z0-9_-]+)\/?$/;
// `/app`, `/app/` and `/app/...`, but not `/apps` or `/application`.
const COLLECTOR_PATH = /^\/app(?:\/(.*))?$/;

/** The page for a URL path (`location.pathname`, no query or hash). */
export function matchRoute(pathname: string): Route {
  if (pathname === '/') return { name: 'orderForm' };

  const orderPage = ORDER_PAGE_PATH.exec(pathname);
  if (orderPage?.[1] !== undefined) return { name: 'orderPage', token: orderPage[1] };

  if (pathname === '/login' || pathname === '/login/') return { name: 'login' };

  const collector = COLLECTOR_PATH.exec(pathname);
  if (collector) return { name: 'collector', path: trimSlashes(collector[1] ?? '') };

  return { name: 'notFound' };
}

/** `path` without leading and trailing slashes. */
function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** Options of {@link navigate}. */
export interface NavigateOptions {
  /**
   * Stored as `history.state` and read back through `useLocation().state`. It survives a reload
   * and the back button, so it must be structured-cloneable (plain data). Section 9 navigates to
   * `/` with `{ orderPrefill }` ("הזמנה חדשה עם אותם פרטים") and the form reads it.
   */
  state?: unknown;
  /** Replace the current history entry instead of adding one (the back button skips it). */
  replace?: boolean;
}

// Components subscribed through useLocation. pushState and replaceState do not fire `popstate`,
// so `navigate` tells these listeners itself; `popstate` covers the back and forward buttons.
const listeners = new Set<() => void>();

/** Goes to `to` (a same-origin path) without reloading the page, and re-renders the app. */
export function navigate(to: string, options: NavigateOptions = {}): void {
  const state = options.state ?? null;
  if (options.replace) window.history.replaceState(state, '', to);
  else window.history.pushState(state, '', to);
  for (const listener of listeners) listener();
}

/** Where the app is now, as {@link useLocation} returns it. */
export interface AppLocation {
  pathname: string;
  /** `history.state` of the current entry: whatever `navigate` stored, or null. */
  state: unknown;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('popstate', onChange);
  };
}

// useSyncExternalStore compares snapshots by identity and re-renders on every new object, so a
// fresh `{ pathname, state }` on every call would loop forever. The last snapshot is kept and
// handed out again until the path or the state object actually changes.
let lastSnapshot: AppLocation | null = null;

function getSnapshot(): AppLocation {
  const pathname = window.location.pathname;
  const state: unknown = window.history.state;
  if (lastSnapshot?.pathname !== pathname || lastSnapshot.state !== state) {
    lastSnapshot = { pathname, state };
  }
  return lastSnapshot;
}

/**
 * The current path and history state. The component re-renders after {@link navigate}, a
 * {@link Link} click, and the browser's back and forward buttons.
 */
export function useLocation(): AppLocation {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Props of {@link Link}. */
export interface LinkProps {
  /** A same-origin path, such as `/` or `/o/<token>`. */
  to: string;
  /** History state for the target page; see {@link NavigateOptions.state}. */
  state?: unknown;
  className?: string;
  /**
   * `'page'` on the link to the screen being shown, as in the collector app's bottom navigation:
   * screen readers announce it as the current page, and CSS styles it through the attribute.
   */
  'aria-current'?: 'page';
  children: ReactNode;
}

/**
 * A real `<a href>`, so it works before the script loads, can be long-pressed and opened in a
 * new tab, and is announced as a link. A plain left click is handled in the page through
 * {@link navigate}, with no reload; a click with a modifier key (new tab, new window, download)
 * is left to the browser.
 */
export function Link({ to, state, className, 'aria-current': ariaCurrent, children }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    const isPlainLeftClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !isPlainLeftClick) return;
    event.preventDefault();
    navigate(to, { state });
  }

  return (
    <a href={to} className={className} aria-current={ariaCurrent} onClick={handleClick}>
      {children}
    </a>
  );
}
