// Session cookies in api tests: building the Cookie header of a logged-in request, and reading the
// Set-Cookie lines of a response. Test-only, like fakeDeps.ts and testRequest.ts.
import type { SessionPayload } from '@bottlerun/shared';
import type { AuthDeps } from '../deps.ts';
import { SESSION_COOKIE_NAME, newSessionPayload, signSession } from './session.ts';

/** Epoch seconds of `date`, rounded down: the unit of a session's `iat` and `exp`. */
export function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** A Cookie header that carries `token` as the session cookie. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** The session token for `payload`, signed with the test app's secret (`auth.sessionSecret`). */
export function signedToken(auth: AuthDeps, payload: SessionPayload): string {
  return signSession(payload, auth.sessionSecret);
}

/** A Cookie header with a valid session issued at `issuedAt`, as the login would have set it. */
export function loggedInCookie(auth: AuthDeps, issuedAt: Date): string {
  return sessionCookieHeader(signedToken(auth, newSessionPayload({ sub: 'collector' }, issuedAt)));
}

/**
 * The Set-Cookie line of a supertest response for the cookie `name` (the session cookie unless
 * said otherwise), or undefined when the response sets no such cookie.
 */
export function setCookieLine(
  res: { headers: Record<string, unknown> },
  name: string = SESSION_COOKIE_NAME,
): string | undefined {
  const header = res.headers['set-cookie'];
  const lines: unknown[] = Array.isArray(header) ? header : [];
  return lines.find(
    (line): line is string => typeof line === 'string' && line.startsWith(`${name}=`),
  );
}

/** The value of a Set-Cookie line: what follows `name=`, up to the first `;`. */
export function setCookieValue(line: string): string {
  return line.slice(line.indexOf('=') + 1).split(';', 1)[0] ?? '';
}

/** The attributes of a Set-Cookie line, trimmed: `['Max-Age=7776000', 'Path=/', 'HttpOnly', …]`. */
export function setCookieAttributes(line: string): string[] {
  return line
    .split(';')
    .slice(1)
    .map((attribute) => attribute.trim());
}
