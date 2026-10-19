// Code shared by apps/web and apps/api. Consumed as TypeScript source (no build step):
// package.json "exports" points straight at this file, and Vite / tsx / Vitest compile it.
// Must stay isomorphic: no imports from express, react, or either app (enforced in eslint.config.js).

/** Project name, as shown to customers. */
export const APP_NAME = 'לתת עוד';

/**
 * The slogan shown under {@link APP_NAME} at the top of the booking form (spec §3.1, branding in
 * spec §7): the bottles a customer gives fund tefillin for bar-mitzvah boys and soldiers.
 */
export const APP_SLOGAN = 'הבקבוקים שלכם, התפילין שלהם!';

// Street list, search and region (ADR-0005).
export * from './streets.ts';
// An address's region and map point, from its street codes (ADR-0005).
export * from './location.ts';
// Israeli mobile phone: form validation and the stored E.164 form.
export * from './phone.ts';
// Order statuses and allowed status changes (spec §4).
export * from './orderStatus.ts';
// The stored order (spec §5 + ADRs) and the booking-form input with its Hebrew messages (spec §3.1).
export * from './order.ts';
// The POST /api/orders contract: request, success summary, error bodies and messages (spec §3.1).
export * from './orderApi.ts';
// The /api/auth/* contract: session user and cookie payload, login request, error bodies (ADR-0004).
export * from './authApi.ts';

/**
 * Body of GET /api/health. The web app calls it when the form loads to warm up the function, and
 * the api's ping to the database opens the Mongo connection at the same time (ADR-0002, warm-up).
 * `ok: true` with status 200 when the database answers; `ok: false` with status 503 when it does
 * not.
 */
export interface HealthResponse {
  ok: boolean;
}

/**
 * Body of every api error response. `error` is a stable code for the web app to branch on, never
 * text for the user and never detail about what went wrong inside the server. Codes every route
 * may answer: `invalid_json` (400), `bad_request` (other 4xx), `too_large` (413), `not_found` (404),
 * `internal` (500). Routes add their own codes, and a Hebrew `message` where the user sees it.
 */
export interface ApiErrorBody {
  error: string;
}
