// Headers that make a supertest request look like the web app's own: sent to the site's host,
// from the site's origin, so it passes the Origin check (sameOrigin.ts) on POST, PATCH, …
// Test-only, like fakeDeps.ts. Supertest's default Host is 127.0.0.1:<random port>, unknown before
// the request is sent, so the tests pin both headers to one made-up host instead.

/** The host api tests send their requests to (`.test` is reserved, so it is never a real site). */
export const TEST_HOST = 'latet-od.test';

/** The Origin of the web app served on {@link TEST_HOST}. */
export const TEST_ORIGIN = `https://${TEST_HOST}`;

/**
 * Host and Origin of the same site, for supertest's `.set()`:
 * `request(app).post('/api/orders').set(SAME_ORIGIN_HEADERS).send(body)`.
 */
export const SAME_ORIGIN_HEADERS: Readonly<Record<'Host' | 'Origin', string>> = {
  Host: TEST_HOST,
  Origin: TEST_ORIGIN,
};
