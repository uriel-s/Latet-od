// The session cookie on the wire (ADR-0004): reading it from the request's Cookie header, setting
// it with the ADR's attributes, and clearing it on logout. A tiny parser instead of cookie-parser:
// the api reads one cookie, and every dependency is one more thing to keep up to date.
import type { Response } from 'express';
import type { SessionPayload } from '@bottlerun/shared';
import type { AuthDeps } from '../deps.ts';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, signSession } from './session.ts';

/**
 * The value of the cookie `name` in a Cookie request header (`a=1; session=xyz`), or undefined
 * when it is not there.
 *
 * - Parts are split on `;`, each at its FIRST `=`, so a value may itself contain `=`. Name and
 *   value are trimmed of the spaces around them.
 * - A part without `=`, or with an empty name, is ignored, never an error: the header comes from
 *   the client.
 * - Names are case-sensitive, and only a whole name matches (`xsession=…` is not `session`).
 * - When the name appears twice, the first wins, as in the `cookie` library Express uses. A
 *   browser sends the cookie with the longest path first, and the api sets only `Path=/`.
 * - The value is returned as sent, not URL-decoded: the session token is base64url and a dot,
 *   which never needs encoding, so a value with `%` in it is not ours and simply fails the check.
 *
 * @param cookieHeader `req.headers.cookie` (Node joins several Cookie headers with `; `).
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * The attributes of the session cookie (ADR-0004): httpOnly, so page scripts never see it;
 * Secure, so it never travels over plain http (except in local development, see AuthDeps);
 * SameSite=Lax, which with the Origin check is the CSRF protection; one path for the whole site.
 */
function sessionCookieAttributes(auth: AuthDeps): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
} {
  return { httpOnly: true, secure: auth.secureCookie, sameSite: 'lax', path: '/' };
}

/**
 * Sets the session cookie for `payload`, signed with the session secret, to last
 * {@link SESSION_MAX_AGE_MS} (90 days) in the browser too. Used by the login and by the renewal
 * in requireCollector.
 */
export function setSessionCookie(res: Response, payload: SessionPayload, auth: AuthDeps): void {
  res.cookie(SESSION_COOKIE_NAME, signSession(payload, auth.sessionSecret), {
    ...sessionCookieAttributes(auth),
    maxAge: SESSION_MAX_AGE_MS,
  });
}

/**
 * Tells the browser to delete the session cookie: an empty value that expired in 1970 (Express's
 * clearCookie). Sent with the attributes the cookie was set with: the browser replaces a cookie
 * only when name and path match, and a Secure cookie only from a Secure one.
 */
export function clearSessionCookie(res: Response, auth: AuthDeps): void {
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieAttributes(auth));
}
