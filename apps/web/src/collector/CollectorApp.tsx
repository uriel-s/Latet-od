// The collector app at /app/* behind its login guard (spec §3 "אפליקציית האוסף", ADR-0004).
// On opening, it asks the api whether this browser is logged in (GET /api/auth/me, api.ts
// `fetchSession`): logged in shows the app (CollectorShell), logged out goes to /login, and no
// answer offers a retry. The api guards every /api/collector/* route itself; this guard only
// decides what to show, so Yoel never sees an app whose every request would answer 401.
import { useEffect, useState } from 'react';
import { fetchSession, logout, type SessionOutcome } from '../api.ts';
import { navigate } from '../router.tsx';
import { CollectorShell } from './CollectorShell.tsx';

/** The heading while the guard waits for the api, or offers the retry. */
const APP_TITLE = 'אפליקציית האוסף';

/** Shown when the session check got no usable answer (network error, 5xx). */
export const SESSION_CHECK_FAILED_MESSAGE =
  'לא הצלחנו לטעון את האפליקציה. נא לבדוק את החיבור לאינטרנט ולנסות שוב.';

/** Props of {@link CollectorApp}. */
export interface CollectorAppProps {
  /** The rest of the URL after `/app/`, without slashes at either end (router.tsx). */
  path: string;
  /**
   * Asks whether this browser is logged in. Defaults to {@link fetchSession}; tests pass a fake.
   * Must keep its identity across renders (a module function, not an inline arrow): a new one
   * runs the check again.
   */
  loadSession?: () => Promise<SessionOutcome>;
  /** Ends the session. Defaults to {@link logout} (POST /api/auth/logout); tests pass a fake. */
  logOut?: () => Promise<boolean>;
}

/** What the guard knows. A logged-out answer leaves for /login and needs no state of its own. */
type GuardState = 'checking' | 'failed' | 'loggedIn';

/**
 * The collector app with its login guard. The session is checked once per mount, and again only
 * when Yoel taps "לנסות שוב": switching tabs changes `path` on the same mounted component (App.tsx
 * renders it at the same place for every /app/* path), so it neither checks nor flashes the
 * loading screen again.
 *
 * A failed check never sends him to the login: a dropped connection mid-round is not a logout,
 * and the session cookie is most likely still good. The screen says so and offers a retry.
 */
export function CollectorApp({
  path,
  loadSession = fetchSession,
  logOut = logout,
}: CollectorAppProps) {
  const [guard, setGuard] = useState<GuardState>('checking');
  // Counts the "לנסות שוב" taps: a new value runs the check below again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // False once this check's answer no longer matters: the app unmounted (Yoel left /app), a
    // retry started a newer check, or React's StrictMode ran the effect a second time (dev
    // only). A stale answer changes nothing; above all, a late "logged out" must not pull a
    // visitor who already left /app over to the login.
    let current = true;

    function settle(outcome: SessionOutcome): void {
      if (!current) return;
      switch (outcome.kind) {
        case 'loggedIn':
          setGuard('loggedIn');
          return;
        case 'loggedOut':
          // Replace, not push: the guarded URL leaves the history, so "back" from the login
          // does not land here and bounce straight back to the login.
          navigate('/login', { replace: true });
          return;
        case 'failed':
          setGuard('failed');
          return;
      }
    }

    // fetchSession never rejects; a rejection is a failed check like any other.
    loadSession().then(settle, () => settle({ kind: 'failed' }));
    return () => {
      current = false;
    };
  }, [loadSession, attempt]);

  function retry(): void {
    setGuard('checking');
    setAttempt((previous) => previous + 1);
  }

  if (guard === 'loggedIn') return <CollectorShell path={path} logOut={logOut} />;

  // Waiting, or failed: the page's one <h1> is the app's name until a screen replaces it.
  return (
    <>
      <h1>{APP_TITLE}</h1>
      {guard === 'checking' ? (
        <p role="status">טוען...</p>
      ) : (
        <>
          <p className="form-alert" role="alert">
            {SESSION_CHECK_FAILED_MESSAGE}
          </p>
          <button type="button" className="button button-primary button-block" onClick={retry}>
            לנסות שוב
          </button>
        </>
      )}
    </>
  );
}
