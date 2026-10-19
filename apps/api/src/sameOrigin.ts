// CSRF protection (ADR-0004, "CSRF"): a request that changes something passes only when its
// `Origin` header names the host it was sent to. The site and the api share one origin (ADR-0002),
// so the web app's own requests always match, and with SameSite=Lax this replaces a CSRF token.
import type { RequestHandler } from 'express';
import type { ForbiddenOriginErrorBody } from '@bottlerun/shared';

/**
 * Methods that only read. The api changes nothing on them (every action is POST/PATCH, ADR-0004),
 * so they pass whatever their Origin: a link or an `<img>` from another site may load them, and
 * the response is not readable cross-origin anyway (no CORS headers).
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Express middleware that refuses every request with a method other than GET, HEAD and OPTIONS
 * (POST, PUT, PATCH, DELETE, …) unless its `Origin` header is a URL whose host (name and port)
 * equals `req.host`, the host the request was sent to. A refused request gets 403 with a
 * {@link ForbiddenOriginErrorBody} and never reaches the route.
 *
 * Why this is enough (ADR-0004):
 * - A page on another site can make its visitor's browser POST here (an auto-submitted form, a
 *   `fetch` in `no-cors` mode). SameSite=Lax keeps the session cookie off such a POST, but a
 *   "site" is wider than an origin (a sibling subdomain is the same site), and the public booking
 *   form has no cookie at all: that page could book orders from each visitor's own IP, past the
 *   per-IP limit. The `Origin` header closes both: the browser sets it, and a page cannot change
 *   it (a forbidden header name).
 * - A missing Origin, `Origin: null` (a sandboxed iframe, a `data:` page) or a value that is not a
 *   URL is refused too. Every current browser sends Origin on every POST, same-origin `fetch`
 *   included, so only a non-browser client lacks it, and such a client is not a CSRF victim: it
 *   could send any Origin it likes, and it has no visitor's cookie to abuse.
 * - Only the host is compared, not the scheme: a cross-site page cannot claim our host whatever
 *   its scheme, and HTTPS is the proxy's concern (Vercel terminates TLS, so the api sees http).
 * - `req.host` is the Host header, or X-Forwarded-Host when the trusted proxy sets it (`trust
 *   proxy` = 1 in app.ts): on Vercel the public host the browser used. A cross-site page cannot set
 *   X-Forwarded-Host either: a custom header makes the browser ask first (CORS preflight), and the
 *   api answers no CORS, so the request is never sent.
 *
 * Mount it before the body parser, so a refused request's body is never parsed. It logs nothing:
 * neither the Origin nor the IP reaches the log.
 *
 * The web app must never set `Referrer-Policy: no-referrer`: under that policy browsers send
 * `Origin: null` even on same-origin POSTs, and every one would be refused here.
 */
export function requireSameOrigin(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || isSameOrigin(req.get('Origin'), req.host)) {
      next();
      return;
    }
    const body: ForbiddenOriginErrorBody = { error: 'forbidden_origin' };
    res.status(403).json(body);
  };
}

/**
 * True when `origin` (the Origin header) is a URL whose host is `host` (the request's host, name
 * and port). Host names are case-insensitive: the URL parser lowercases the Origin's, so the
 * request's is lowercased too. A missing side never matches (Express gives `req.host` as
 * undefined, never '', when there is no Host header).
 */
function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false;
  // URL.parse answers null, not an exception, for `null` and anything else that is not a URL.
  return URL.parse(origin)?.host === host.toLowerCase();
}
